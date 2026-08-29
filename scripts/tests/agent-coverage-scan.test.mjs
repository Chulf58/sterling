// AUTHORING-SIDE REGISTRY COVERAGE — the update fan-out's blind spot (fix (c)).
//
// SPEC ONLY. Nothing in scripts/lib/update.mjs, scripts/update.mjs,
// scripts/sync-agents.mjs or scripts/lib/agent-distribution.mjs was read to
// author this file (H4 read wall). The contract comes from board 6ce18724,
// research_finding 0038af7c and the launching agent's user-ruled shape.
//
// THE DEFECT: /sterling:update fans out over the projects in the shared project
// registry and reports "N projects synced" — but it cannot report what it does
// not know about. Measured: 9 projects on this machine carry Sterling agents,
// the registry knows 7, and the two it does not know have been frozen 43 and 80
// days. The fan-out's report was true and useless. Pair it with a scan of the
// known roots for projects that have installed sterling-generated agents but are
// absent from the registry, so the blind spot becomes a number someone can read.
//
// ---------------------------------------------------------------------------
// INVENTED INTERFACE — the design named no function, so this file FIXES one.
// This is a specification for the implementer, not something read out of code:
//
//   // scripts/lib/agent-coverage.mjs  (NEW module; lib/update.mjs imports it
//   // and prints its report beside the "N projects synced" line)
//   export function scanAgentCoverage({ roots, registeredProjects }) => {
//     scanned: number,                               // candidate project dirs inspected
//     unregistered: [{ path, agents: string[] }],    // sorted by path; agents sorted
//     unreadable_roots: [{ root, error }],           // NEVER silently dropped (P5)
//   }
//
//   - `roots`: absolute directories that contain projects. A candidate project
//     is a DIRECT CHILD of a root holding .claude/agents/.
//   - A project counts as carrying Sterling agents when at least one file in
//     .claude/agents/ has a valid sterling-generated header. Foreign files do
//     not make a project Sterling's business.
//   - Path comparison against `registeredProjects` is NORMALIZED (resolved,
//     forward slashes, no trailing separator) — the store's POSIX path
//     invariant, and the Windows/Linux parity requirement, both demand it.
//   - It REPORTS. It never writes, never re-registers, never blocks. (b) —
//     self-heal/re-register — was ruled OUT for this build.
//
// A NEW module is specified deliberately: it keeps the pure, testable scan out
// of lib/update.mjs's live fan-out path, and other lanes are currently editing
// in that territory.
//
// NOT PINNED HERE (flagged to the conductor): the WIRING — that runUpdate
// actually calls this and prints it — is not pinned, because exercising the
// fan-out needs a real clone, a real registry db and git network work. That
// wiring must be confirmed by review, not by this file.
//
// NO RED OUTPUT IS CLAIMED: the test-writer holds no Bash. These were never
// executed. Run them with:
//   node --test scripts/tests/agent-coverage-scan.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { renderInstalledAgent } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = '2026-01-01T00:00:00.000Z';

// The module under test does not exist yet. Importing it at module scope would
// make this whole file die at load (a crash, which proves nothing); loading it
// defensively means each test fails on its OWN assertion instead.
let scanAgentCoverage = null;
let importError = null;
before(async () => {
  try {
    ({ scanAgentCoverage } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'agent-coverage.mjs')).href));
  } catch (e) {
    importError = e;
  }
});

function requireScan() {
  assert.equal(
    typeof scanAgentCoverage,
    'function',
    `scripts/lib/agent-coverage.mjs must export scanAgentCoverage({roots, registeredProjects}) — not loadable yet: ${importError && importError.message}`
  );
  return scanAgentCoverage;
}

const TPL = (name) => `---
name: ${name}
description: Fixture agent for the coverage-scan tests.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"${process.execPath.replace(/\\/g, '/')}" "/fixture/hooks/h.mjs"'
---

Fixture body for ${name}.
`;

const posix = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
/** tmpdir may be a symlink on some platforms; accept either form of the same dir. */
const samePath = (actual, expected) =>
  posix(actual) === posix(expected) || posix(actual) === posix(realpathSync(expected));

function makeRoot(prefix = 'sterling-cov-root-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A project directory under `root` carrying properly-generated Sterling agents. */
function makeAgentProject(rootDir, name, agentNames = ['coder', 'test-writer']) {
  const dir = join(rootDir, name);
  const agentsDir = join(dir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of agentNames) {
    const { installedContent } = renderInstalledAgent(TPL(agent), `${agent}.md`, { pluginVersion: '0.1.0', now: T0 });
    writeFileSync(join(agentsDir, `${agent}.md`), installedContent);
  }
  return dir;
}

/** A project directory with a .claude/agents/ holding only hand-written files. */
function makeForeignAgentProject(rootDir, name) {
  const dir = join(rootDir, name);
  const agentsDir = join(dir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'my-own-helper.md'), '---\nname: my-own-helper\n---\nhand-written, not Sterling\n');
  return dir;
}

// =============================================================================
// CONTROL ARM — PLACED FIRST. Every pin below reports SOMETHING; a green there
// could equally mean "the scan reports everything it sees". This arm must pass
// for the opposite reason: a fully-registered root reports NOTHING, while
// `scanned` proves the scan actually looked.
// =============================================================================

test('CONTROL: every project under the root is registered — nothing is reported, but the scan proves it looked', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    const a = makeAgentProject(rootDir, 'project-a');
    const b = makeAgentProject(rootDir, 'project-b');

    const res = scan({ roots: [rootDir], registeredProjects: [a, b] });
    assert.deepEqual(res.unregistered, [], 'a fully-covered root reports no blind spot');
    assert.deepEqual(res.unreadable_roots, [], 'and nothing degraded');
    assert.ok(res.scanned >= 2, `the scan inspected both candidate projects (scanned=${res.scanned}) — a scan that reports nothing because it looked at nothing is not a pass`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: report every scanned project as unregistered (drop the
// registeredProjects membership test) — `unregistered` is no longer empty,
// caught. Complementary sabotage: `return { scanned: 0, unregistered: [], ... }`
// (a scan that never walks) — the `scanned >= 2` assertion fires, which is what
// stops this control from passing for the wrong reason.

// =============================================================================
// THE MEASURED CASE
// =============================================================================

test('MEASURED CASE: a project with installed sterling agents that the registry does not know is reported, naming its path and agents', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    const known = makeAgentProject(rootDir, 'project-known');
    const hidden = makeAgentProject(rootDir, 'project-hidden', ['coder', 'test-writer', 'librarian']);

    const res = scan({ roots: [rootDir], registeredProjects: [known] });
    assert.equal(res.unregistered.length, 1, `exactly the one unregistered project is reported: ${JSON.stringify(res.unregistered)}`);
    const [found] = res.unregistered;
    assert.ok(samePath(found.path, hidden), `the report names the project PATH (got ${found.path})`);
    assert.deepEqual([...found.agents].sort(), ['coder', 'librarian', 'test-writer'], 'and names the installed agents it found there');
  } finally {
    cleanup();
  }
});
// SABOTAGE: return `unregistered: []` unconditionally, or iterate
// registeredProjects instead of the roots (the exact shape of the original
// defect — you cannot report what you only enumerate from the registry) — the
// length assertion flips 1→0, caught. Narrower: report the path but not the
// agent names — the deepEqual on `agents` fires.

test('a registered project is never DOUBLE-reported, even when the registry stores its path in an unnormalized form', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    makeAgentProject(rootDir, 'project-a');
    // The same directory, spelled two legal ways a registry might hold it —
    // and DELIBERATELY never in its exact resolved form, so a strict-equality
    // implementation cannot pass this by accident.
    const weird = [`${rootDir}/project-a/`, `${rootDir}/./project-a`];

    const res = scan({ roots: [rootDir], registeredProjects: weird });
    assert.deepEqual(res.unregistered, [], 'trailing separators and redundant "." segments still identify the SAME project — a normalized comparison, per the POSIX path invariant');
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare with raw `registeredProjects.includes(dir)` string equality
// instead of normalizing both sides — the trailing-slash form stops matching and
// project-a is falsely reported, caught. This is the pin that keeps the report
// from crying wolf on Windows-vs-POSIX path spellings, which is how a coverage
// report gets ignored.

test('a directory with NO sterling-generated agents is not reported — a foreign .claude/agents is not Sterling\'s business', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    makeForeignAgentProject(rootDir, 'project-foreign');
    mkdirSync(join(rootDir, 'project-plain', 'src'), { recursive: true }); // no .claude at all
    const hidden = makeAgentProject(rootDir, 'project-hidden');

    const res = scan({ roots: [rootDir], registeredProjects: [] });
    assert.equal(res.unregistered.length, 1, `only the project with real Sterling agents is reported: ${JSON.stringify(res.unregistered)}`);
    assert.ok(samePath(res.unregistered[0].path, hidden), 'and it is the right one');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat the mere existence of .claude/agents (or of any directory) as
// "carries Sterling agents", skipping the sterling-generated header parse —
// project-foreign joins the report, length flips 1→2, caught. A coverage report
// that flags every project with hand-written subagents is noise, and noise is
// how the 80-day staleness stayed invisible in the first place.

// =============================================================================
// DEGRADE LOUD, NEVER SILENT (P5)
// =============================================================================

test('DEGRADE LOUD: an unreadable known root is reported as unreadable, and the other root is still scanned', () => {
  const scan = requireScan();
  const good = makeRoot('sterling-cov-good-');
  try {
    const hidden = makeAgentProject(good.dir, 'project-hidden');
    const missingRoot = join(good.dir, 'no-such-root-directory');

    const res = scan({ roots: [missingRoot, good.dir], registeredProjects: [] });

    assert.equal(res.unreadable_roots.length, 1, `the unreadable root is REPORTED, never swallowed: ${JSON.stringify(res.unreadable_roots)}`);
    assert.ok(samePath(res.unreadable_roots[0].root, missingRoot), 'naming which root could not be read');
    assert.ok(res.unreadable_roots[0].error, 'and why');

    assert.equal(res.unregistered.length, 1, 'one bad root does not abort the scan of the good one');
    assert.ok(samePath(res.unregistered[0].path, hidden), 'the good root\'s finding still lands');
  } finally {
    good.cleanup();
  }
});
// SABOTAGE: `try { readdirSync(root) } catch { continue; }` — a silent skip
// makes "0 unregistered projects" indistinguishable from "half the machine was
// never looked at"; unreadable_roots empties and the first assertion fires,
// caught. Opposite sabotage — letting the throw escape — kills the second half
// of the test (the good root's finding never lands), so BOTH failure directions
// are pinned here, not just the silent one.

// #############################################################################
// APPENDED 2026-08-29 — REVIEW-FIX PINS.
//
// READ THIS BEFORE READING A GREEN RUN AS A NO-OP. Every arm ABOVE this banner
// was written BEFORE the implementation and went red-then-green in the usual
// way. Every arm BELOW it is the INVERSE: the fixes it pins are ALREADY IN THE
// CODE, so these are expected GREEN on an unmodified tree and RED only under the
// one-line sabotage named beneath each one. A green run here is the pin holding,
// not the pin doing nothing.
//
// WHY THEY EXIST: a fixer applied eleven review findings and then measured that
// these suites caught almost none of them — this file stayed 5/5 GREEN with
// `dedupeRoots` returning a raw `new Set` (F3 below is the fixture that catches
// it). A fix nobody pins regresses the first time somebody tidies the code.
//
// STILL SPEC-ONLY: scripts/lib/agent-coverage.mjs and scripts/lib/update.mjs
// were NOT read (H4 read wall). The expectations come from the fix list in the
// dispatch brief, the interface contract at the top of this file, board 6ce18724
// and research_finding 0038af7c.
//
// PLACEMENT NOTE: F10's case-folding half is pinned HERE rather than in
// agent-currency-h1.test.mjs, even though the brief filed it on the H1 side. The
// property it names — "a registered path differing only in case must NOT be
// reported unregistered" — is stated entirely in this module's vocabulary
// (`registeredProjects`, `unregistered`), and there is no H1-observable surface
// that exercises it. Reported to the conductor rather than forced.
//
// Run with:  node --test scripts/tests/agent-coverage-scan.test.mjs
// #############################################################################

import { chmodSync, symlinkSync } from 'node:fs';
import { runUpdate } from '../lib/update.mjs';

/** chmod is advisory-to-absent as root and on some mounts. Probe rather than let
 *  an EACCES arm pass vacuously — a green that proves nothing is exactly what
 *  this append exists to prevent. */
function chmodDenialWorks() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-chmod-probe-'));
  const sub = join(d, 'locked');
  try {
    mkdirSync(join(sub, 'inner'), { recursive: true });
    chmodSync(sub, 0o000);
    try {
      realpathSync(join(sub, 'inner'));
      return false; // traversal succeeded despite mode 000 — probably root
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      chmodSync(sub, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
}

/** A base directory on a CASE-INSENSITIVE filesystem, or null when this host has
 *  none reachable. Under WSL `process.platform === 'linux'` while /mnt/<drive>/
 *  is drvfs and case-INSENSITIVE — that mismatch is the whole of F10's WSL half,
 *  and it cannot be exercised from /tmp, which is ext4 and case-sensitive. */
const CASE_INSENSITIVE_BASE = (() => {
  if (process.platform === 'win32') return tmpdir();
  const repo = String(root).replace(/\\/g, '/');
  return /^\/mnt\/[a-z]\//i.test(repo) ? dirname(repo) : null;
})();

// =============================================================================
// CONTROL — PLACED FIRST IN THIS BLOCK. Every pin below reports something new
// (`unreadable_projects`, a candidate count, a fold). A green there could equally
// mean "the scan reports everything it sees, in every bucket". This arm must
// pass for the OPPOSITE reason: a fully-current, fully-registered, fully-readable
// root produces THREE empty buckets and a non-zero `scanned`.
// =============================================================================

test('CONTROL (appended): a fully-registered, fully-readable root produces SILENCE in all three buckets — including the new unreadable_projects', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    const a = makeAgentProject(rootDir, 'project-a');
    const b = makeAgentProject(rootDir, 'project-b');
    makeForeignAgentProject(rootDir, 'project-foreign');

    const res = scan({ roots: [rootDir], registeredProjects: [a, b] });

    assert.deepEqual(res.unregistered, [], 'nothing is unregistered');
    assert.deepEqual(res.unreadable_roots, [], 'no root was unreadable');
    assert.deepEqual(res.unreadable_projects ?? [], [], 'and NO project was unreadable — the new bucket must stay empty on a clean machine, or every pin below it passes for the wrong reason');
    assert.ok(res.scanned >= 3, `the scan still looked (scanned=${res.scanned}) — silence from a scan that walked nothing is not a pass`);
  } finally {
    cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): push every candidate whose stat/readdir was merely
// attempted into `unreadable_projects` (i.e. report on the attempt rather than on
// the failure) — the third deepEqual fires, caught. Complementary sabotage:
// `return { scanned: 0, ... }` — the `scanned >= 3` assertion fires. HALF THESE
// FIXES ARE "REPORT MORE LOUDLY"; without this arm, an implementation that shouts
// on every session satisfies all of them and is useless (P1).

// =============================================================================
// F3 — roots are NORMALIZED BEFORE de-duplication
// =============================================================================

test('F3: two spellings of ONE root are walked ONCE — normalization happens before de-duplication, so `scanned` is not multiplied', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    makeAgentProject(rootDir, 'project-a');
    makeAgentProject(rootDir, 'project-hidden');

    const once = scan({ roots: [rootDir], registeredProjects: [] });
    // The SAME directory, spelled three legal ways. A raw `new Set` holds three
    // distinct strings and walks the tree three times.
    const thrice = scan({ roots: [rootDir, `${rootDir}/`, `${rootDir}/./`], registeredProjects: [] });

    assert.ok(once.scanned >= 2, `baseline sanity: the single-spelling scan walked the root (scanned=${once.scanned})`);
    assert.equal(thrice.scanned, once.scanned, `three spellings of one root must produce the SAME candidate count as one spelling (got ${thrice.scanned} vs ${once.scanned}) — a doubled count makes the blind-spot number a lie in the safe direction, which is the direction nobody checks`);
    assert.equal(thrice.unregistered.length, once.unregistered.length, 'and the same findings, reported once each');
    assert.deepEqual(thrice.unreadable_roots, [], 'a redundant spelling is not a degraded root');
  } finally {
    cleanup();
  }
});
// EXPECTED: GREEN on the current tree. This is one of the two findings MEASURED
// unpinned: this file stayed 5/5 GREEN under the raw-Set regression.
// SABOTAGE (one line): make `dedupeRoots` return `new Set(roots)` without
// normalizing first — the three spellings survive as three roots, `scanned`
// triples and the equality assertion fires, caught. NOTE the third assertion is
// NOT redundant defence-in-depth: an implementation could dedupe the FINDINGS
// while still walking three times, which fixes the report and leaves the cost
// and the count wrong — only the `scanned` assertion sees that.

// =============================================================================
// F4 + F8 (scan half) — an inaccessible CHILD is a project-level defect, and it
// makes an affirmative "everything is registered" UNREACHABLE
// =============================================================================

test('F4/F8: an inaccessible child project lands in unreadable_projects, NEVER in unreadable_roots, and is never counted as "absent"', (t) => {
  if (!chmodDenialWorks()) {
    t.skip('mode 000 does not deny directory traversal on this host (root, or a mount without POSIX modes) — the EACCES branch is unreachable here');
    return;
  }
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  const locked = join(rootDir, 'project-locked');
  try {
    const a = makeAgentProject(rootDir, 'project-a');
    makeAgentProject(rootDir, 'project-locked');
    chmodSync(locked, 0o000); // statSync(project/.claude/agents) now throws EACCES

    const res = scan({ roots: [rootDir], registeredProjects: [a] });

    assert.equal(
      (res.unreadable_projects ?? []).length,
      1,
      `the inaccessible project is REPORTED as unreadable: ${JSON.stringify(res.unreadable_projects)}. existsSync() answers false for EACCES exactly as it does for "absent", which is how a whole project disappears from a coverage report that then prints a clean bill of health.`
    );
    assert.ok(samePath(res.unreadable_projects[0].path ?? res.unreadable_projects[0].project, locked), 'naming WHICH project could not be inspected');
    assert.ok(res.unreadable_projects[0].error, 'and why');

    assert.deepEqual(res.unreadable_roots, [], 'the ROOT was perfectly readable — a project-level failure must not be reported as a root-level one, because the root message says no project beneath it was inspected, and here every other project WAS');
    assert.deepEqual(res.unregistered, [], 'and the locked project is NOT asserted to be unregistered — nothing could be read from it, so no claim about it is available either way');
  } finally {
    try {
      chmodSync(locked, 0o755);
    } catch {
      /* best effort */
    }
    cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE for F4 (one line): push the inaccessible child into `unreadable_roots`
// instead of `unreadable_projects` — the third assertion (`unreadable_roots` is
// empty) fires, caught; the first fires too. The two buckets carry DIFFERENT
// claims: "no project beneath this root was inspected" versus "this one project
// could not be inspected", and merging them overstates the damage by the size of
// the root.
// SABOTAGE for F8's scan half (one line): go back to
// `if (!existsSync(join(dir, '.claude', 'agents'))) continue;` — EACCES is
// indistinguishable from absence, the locked project is silently skipped,
// `unreadable_projects` empties and the first assertion fires, caught. That skip
// is precisely what makes an affirmative "ok — every project is registered"
// reachable from a scan that never saw half of what it claims to cover.

// =============================================================================
// F5 — `scanned` counts CANDIDATE directories (those holding .claude/agents/),
//      foreign-only ones included
// =============================================================================

test('F5: `scanned` counts CANDIDATE directories holding .claude/agents/ — including foreign-only ones, which were inspected and cleared', () => {
  const scan = requireScan();
  const { dir: rootDir, cleanup } = makeRoot();
  try {
    makeAgentProject(rootDir, 'project-hidden');       // candidate, sterling, unregistered
    makeForeignAgentProject(rootDir, 'project-foreign'); // candidate, inspected, cleared
    mkdirSync(join(rootDir, 'project-plain', 'src'), { recursive: true }); // NOT a candidate

    const res = scan({ roots: [rootDir], registeredProjects: [] });

    assert.equal(res.scanned, 2, `two directories hold .claude/agents/ and both were inspected (got ${res.scanned}) — the foreign one counts, because the work of clearing it is exactly what "scanned" claims to have done`);
    assert.equal(res.unregistered.length, 1, 'while only the sterling-carrying one is a finding');
  } finally {
    cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): count only the directories that turned out to carry
// sterling agents (increment `scanned` inside the sterling-header branch) — the
// count drops 2→1 and the first assertion fires, caught. That is the count half
// of F5; the WORDING half is pinned in the runUpdate arm at the bottom of this
// file, and F5 is the finding that the two must AGREE.

// =============================================================================
// F6 / F10 — a registered project reached through a SYMLINKED parent
// =============================================================================

test('F6/F10: a project registered under a SYMLINKED parent is not falsely reported unregistered — realpath resolution, guarded', (t) => {
  const scan = requireScan();
  const base = mkdtempSync(join(tmpdir(), 'sterling-cov-link-'));
  const realParent = join(base, 'real');
  const linkParent = join(base, 'link');
  try {
    mkdirSync(realParent, { recursive: true });
    try {
      symlinkSync(realParent, linkParent, 'dir');
    } catch {
      t.skip('this host does not permit symlink creation (native Windows without the privilege) — the realpath branch is unreachable here');
      return;
    }
    makeAgentProject(realParent, 'project-a');

    // The registry holds the path as the user reached it: through the symlink.
    const res = scan({ roots: [realParent], registeredProjects: [join(linkParent, 'project-a')] });

    assert.deepEqual(
      res.unregistered,
      [],
      'a registered project reached through a symlinked parent must not be reported as a blind spot — a coverage report that cries wolf on every symlinked checkout is a report people learn to skip, which is how the 80-day staleness stayed invisible'
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): drop the guarded `realpathSync` and compare the textual
// forms only — `<base>/real/project-a` never matches `<base>/link/project-a`, the
// project is falsely reported and the deepEqual fires, caught.
// DIRECTION NOTE (why this arm pins the false-POSITIVE side and not the other):
// the guard's fallback-to-textual-form on throw can only ever RE-INTRODUCE a
// false positive — it can never hide a real gap, because an unresolvable path
// still gets compared, just less forgivingly. So the false-positive direction is
// the only direction the fallback can regress in, and it is the one pinned here.

// =============================================================================
// F10 (WSL half) — case-folding keys on the FILESYSTEM, not on process.platform.
// STANDING REQUIREMENT: Windows/Linux 1:1 parity — most users are on Windows,
// and under WSL `process.platform === 'linux'` while /mnt/<drive>/ is drvfs and
// case-INSENSITIVE. A check keyed on the platform is wrong on the majority host.
// =============================================================================

test('F10 WINDOWS/LINUX PARITY: on a case-INSENSITIVE filesystem a registered path differing only in case still matches — the fold keys on the filesystem, not on process.platform', (t) => {
  if (!CASE_INSENSITIVE_BASE) {
    t.skip('no case-insensitive filesystem reachable from this host (not win32, and the repo is not under /mnt/<drive>/) — the fold branch cannot be exercised here');
    return;
  }
  const scan = requireScan();
  const rootDir = mkdtempSync(join(CASE_INSENSITIVE_BASE, 'sterling-covcase-'));
  try {
    makeAgentProject(rootDir, 'Project-Alpha');
    // The registry holds the same directory in a different case — the ordinary
    // result of a path that made a round trip through a Windows-side tool.
    const registeredLowercase = join(rootDir, 'project-alpha');

    const res = scan({ roots: [rootDir], registeredProjects: [registeredLowercase] });

    assert.deepEqual(
      res.unregistered,
      [],
      'PARITY: on drvfs these two spellings are the SAME directory, so the registered project must not be reported as a blind spot. Keying the fold on process.platform === "win32" gets this wrong under WSL, where the platform is linux and the filesystem is not.'
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
// EXPECTED: GREEN on the current tree (on this machine the repo lives under
// /mnt/c/, so the arm RUNS rather than skips; a skip would itself be reportable).
// SABOTAGE (one line): key the fold on `process.platform === 'win32'` alone —
// under WSL no fold happens, `Project-Alpha` and `project-alpha` compare unequal,
// the project is falsely reported and the deepEqual fires, caught. On a native
// Windows host this same sabotage is INVISIBLE, which is exactly why the parity
// requirement is named in the test title: the arm that catches it only catches
// it on the host where the bug exists.

// =============================================================================
// F1 — THE COVERAGE REPORT RUNS ON THE ALREADY-CURRENT PATH
//
// This is the finding that had NO test at all, which is how it survived to
// review: /sterling:update on a current clone printed "Already current — nothing
// to do" and never inspected the blind spot the mechanism exists to find. The
// scan is useless exactly when it is needed, because the machines whose projects
// go stale are the machines whose clone is CURRENT (research_finding 0038af7c:
// the clone was current while two projects sat 43 and 80 days frozen).
//
// A transient probe proved the fix; this is its permanent form.
// =============================================================================

/** Copied from scripts/tests/update.test.mjs — the injected-exec harness, so the
 *  step order is drivable with no network, no npm and no real clone. */
function fakeExec({ behind = 0, ahead = 0, dirty = [], changed = [], failing = null, syncStatus = () => 0, contractStatus = 0 } = {}) {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const exec = (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (failing && line.includes(failing)) return { status: 1, stdout: '', stderr: 'step blew up' };
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged ? '0\t0' : `${behind}\t${ahead}`);
      if (a === 'status --porcelain') return ok(dirty.join('\n'));
      if (a.startsWith('merge --ff-only')) {
        merged = true;
        return ok('Fast-forward');
      }
      if (a.startsWith('diff --name-only')) return ok(changed.join('\n'));
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    if (args[0]?.endsWith('stamp-contract.mjs')) {
      return { status: contractStatus, stdout: contractStatus ? '✗ drift\n' : '0 refusal(s).\n', stderr: '' };
    }
    if (args[0]?.endsWith('sync-agents.mjs')) {
      const status = syncStatus(args[2]);
      return { status, stdout: status === 0 ? 'up_to_date: coder\n' : 'coder: modified\n', stderr: status ? 'REFUSED' : '' };
    }
    return ok('done');
  };
  return { exec, calls };
}

/** A cwd with no .sterling/config.json — the optional steps skip loudly. */
const scratchCwd = () => mkdtempSync(join(tmpdir(), 'sterling-update-cwd-'));

test('F1: the agent-coverage report runs on the ALREADY-CURRENT path — a clone with nothing to pull is exactly the clone whose projects go stale', async () => {
  const cwd = scratchCwd();
  const { dir: rootDir, cleanup } = makeRoot('sterling-cov-update-');
  try {
    const registered = makeAgentProject(rootDir, 'project-registered');
    const { exec, calls } = fakeExec({ behind: 0 });
    const lines = [];

    const report = await runUpdate({
      cwd,
      exec,
      log: (m) => lines.push(String(m)),
      projects: [{ name: 'project-registered', repo_path: registered }],
      opts: {},
    });

    // CONTROL HALF, asserted FIRST: prove the green came from the ALREADY-CURRENT
    // branch and not from the post-fast-forward call site. Without this, a green
    // has two possible causes and cannot distinguish them.
    assert.equal(report.exit, 0, 'an already-current clone exits 0');
    assert.equal(calls.filter((c) => c.includes('merge --ff-only')).length, 0, 'CONTROL: no fast-forward happened — this run really is on the already-current path');
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0, 'CONTROL: and no post-pull step ran either');

    assert.ok(report.coverage, 'the coverage scan RAN on the already-current path — "Already current — nothing to do" is the report that never inspects the blind spot the mechanism exists to find (0038af7c: the clone was current while two projects sat 43 and 80 days frozen)');
    assert.equal(typeof report.coverage.scanned, 'number', 'and it carries a real candidate count, not a stub object');
    assert.ok(Array.isArray(report.coverage.unregistered), 'and a real findings array');
  } finally {
    cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): move the `report.coverage = scanAgentCoverage(...)` call
// back BELOW the already-current `return report` — `report.coverage` is undefined
// and the assertion fires, caught. The two CONTROL assertions above it are what
// stop this arm from passing for the wrong reason: they prove no fast-forward
// occurred, so a green cannot be explained by the OTHER call site.

test('F5 (wording half): the scanned count is worded as CANDIDATE directories holding .claude/agents/, never as "projects with installed agents"', async () => {
  const cwd = scratchCwd();
  const { dir: rootDir, cleanup } = makeRoot('sterling-cov-update-');
  try {
    const registered = makeAgentProject(rootDir, 'project-registered');
    const { exec } = fakeExec({ behind: 0 });
    const lines = [];

    const report = await runUpdate({
      cwd,
      exec,
      log: (m) => lines.push(String(m)),
      projects: [{ name: 'project-registered', repo_path: registered }],
      opts: {},
    });
    const printed = lines.join('\n');

    assert.ok(report.coverage, 'precondition: the coverage report ran (see the F1 arm)');
    const candidateLines = lines.filter((l) => /candidate/i.test(l));
    assert.ok(
      candidateLines.length >= 1,
      `the printed report describes what was counted as CANDIDATE directories. Printed lines were:\n${printed}`
    );
    assert.ok(
      candidateLines.some((l) => l.includes(String(report.coverage.scanned))),
      `and the wording carries the SAME number the scan reported (scanned=${report.coverage.scanned}):\n${candidateLines.join('\n')}`
    );
    assert.doesNotMatch(
      printed,
      /projects with installed agents/i,
      'the count includes foreign-only candidates, so calling them "projects with installed agents" states a number the scan did not measure — a count and a caption that disagree is a lie with a plausible source'
    );
  } finally {
    cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
// EXPECTED: GREEN on the current tree — FLAGGED as the arm most sensitive to the
// host, because the printed line is produced over roots this test cannot fully
// control and its exact phrasing was never read. The assertions were chosen to be
// machine-INDEPENDENT (they compare the caption against the scan's OWN number
// rather than against a hardcoded count), but if this arm alone goes red the
// question is the wording, not the fix.
// SABOTAGE (one line): reword the caption to "N projects with installed agents"
// while still counting candidates — the `candidate` filter empties AND the
// negative assertion fires, caught twice.
//
// NOT PINNED HERE, and reported as such: F8's PRINTER half — the gate that makes
// the affirmative "ok — every project is registered" line UNREACHABLE when
// anything was unreadable or skipped. The renderer is inline inside runUpdate and
// reports over machine-derived roots, so whether the ok branch is taken depends
// on the real machine's projects; an arm asserting it would pass or fail for
// reasons that have nothing to do with the fix. Its DATA precondition — that an
// inaccessible child is recorded rather than silently skipped, which is what makes
// the ok line unreachable — IS pinned, in the F4/F8 arm above.
