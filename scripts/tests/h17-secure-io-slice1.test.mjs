// H17 SECURE-I/O REDESIGN — SLICE 1 (decision 532a4383
// h17-baseline-integrity-redesign-rulings-abcd; design in research_finding
// f2bc631f). Slice 1 lands the SHARED secure-I/O read+classify layer that
// implements Rulings B and C. Per the work order, Slice 1 is otherwise a
// BEHAVIOR-PRESERVING refactor to a descriptor-pinned no-follow I/O layer,
// already covered by the existing 101 h17 tests. This file pins ONLY the two
// genuinely NEW observable behaviors Slice 1 introduces:
//
//   PIN-SLICE1-PROCFS-ABSENT-HARD-DENY  — Ruling C: on Linux, when
//     /proc/self/fd is unavailable, H17 must FAIL-CLOSED (deny agent Bash,
//     Pre exit 2) with a precise error naming 'secure I/O unavailable:
//     /proc/self/fd absent'. It must NOT auto-degrade to lstat/fstat
//     detection — that auto-degrade was explicitly REJECTED on P5 grounds
//     (decision 532a4383's alternatives_rejected: "Silently weakens the
//     Linux posture to defeatable detection ... an unexpected environment
//     that removes prevention must halt, not degrade silently").
//
//   PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE — Ruling B: a symlink encountered
//     on the (A) per-call STATE surface (pathState) is reported UNKNOWABLE /
//     never read-through for attestation purposes — its target is NEVER
//     compared for equality, so a symlink whose target is byte-for-byte,
//     link-for-link IDENTICAL at both checkpoints must still be treated as
//     unattestable and DENY, not "compared and found unchanged, so allow".
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// source was read. Every expectation below comes from decision 532a4383 and
// research_finding f2bc631f, plus the OBSERVABLE preconditions three sibling
// files already establish as frozen (read via Read/Grep on the TEST files
// themselves, which H4 permits — never on the hook):
//   * scripts/tests/h17-baseline-symlink.test.mjs (PIN-B-SYMLINK-AT-PRE et
//     al.) — the (B) content-baseline surface ALREADY denies a symlink
//     unconditionally ON SIGHT, at Pre, before any comparison. That is
//     already exactly Ruling B's "unattestable, never read through" shape
//     for the (B) surface. THIS FILE DOES NOT DUPLICATE THAT — see the
//     disclosure immediately above PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE
//     below for why the (A) state surface is where the genuine gap is.
//   * scripts/tests/h17-ancestor-hardening.test.mjs — establishes the
//     control-arm-first / cause-isolation idiom this file follows, and that
//     a mutation battery must strip every defense-in-depth layer before
//     calling a pin hollow.
//   * scripts/tests/h17-backslash-non-injectivity.test.mjs — establishes the
//     "authored blind, spec-sourced, one comment block per pin naming the
//     expected-failure-shape and the one-line sabotage" convention this file
//     follows throughout.
//   * scripts/tests/h17-pre-state-snapshot.test.mjs — its PIN-LINK test's own
//     PRECONDITION ("assert.equal(h17(dir, 'PreToolUse', L).code, 0)" when
//     the pre-dirty path is ALREADY a symlink before Pre ever runs) is a
//     FROZEN fact this file relies on and does not contradict: Pre currently
//     ALLOWS observing an already-symlink pre-dirty path (unlike the (B)
//     surface's on-sight Pre-deny). PIN-LINK then denies at POST only when
//     the symlink is RE-POINTED. Neither PIN-LINK nor PIN-TYPE (regular file
//     -> symlink) exercises the case this file's PIN 2 targets: a symlink
//     that is IDENTICAL, unmoved, unretargeted, at BOTH checkpoints. That
//     case is the one place a "compare readlink value, allow if equal"
//     implementation and a "symlink states are unattestable, always deny"
//     implementation diverge in their OBSERVABLE behavior — and it is
//     therefore the only fixture that actually isolates Ruling B's change.
//
// HARNESS is a faithful copy of h17-baseline-symlink.test.mjs's idiom
// (makeGitProject, the Pre/Post pair sharing one tool_use_id per lane,
// oneLine, GIT_SKIP/SYMLINK_SKIP, the tracked hooks/h3-contract-gate.mjs
// bundle file used by h17-pre-state-snapshot.test.mjs's pre-dirty pins) — NOT
// imported, since none of those files export anything.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-secure-io-slice1.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// runHook accepts an optional `env` override so PIN-SLICE1-PROCFS-ABSENT can
// thread the required test seam through without touching process.env
// globally (which would leak between tests run in the same process).
function runHook(script, input, cwd, envOverride) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
    env: envOverride ? { ...process.env, ...envOverride } : process.env,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// anti-pattern ee89c3fd: raw multi-line child-process stderr in an assertion
// message poisons the TAP crash/assertion classifier. Flatten whitespace,
// NEVER truncate.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

const CONFIG = {
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs', '**/*.ts'],
      test_globs: ['**/*.test.mjs', 'tests/**'],
      run_commands: { test: 'node --test' },
    },
  ],
  context_watch: { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200000 } },
};

function briefRecord() {
  return {
    ...envelope('brief'),
    slug: 'feat',
    title: 'Feature',
    problem: 'p',
    feature: 'f',
    user_stated: { criteria: [], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'works end to end', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: {
      files: [
        { path: 'src/feature.ts', owning_articles: [] },
        { path: 'src/new-file.ts', owning_articles: [] },
      ],
      reconcile_list: [],
    },
    incidental_scope: ['src/types.ts'],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

// P5: a check that cannot run says so, rather than failing or passing
// vacuously (mirrors every sibling H17 test file's own probe).
const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

// Ruling C names the Linux /proc/self/fd preflight specifically. Per the work
// order, 2a69a8d7 already settled that native Windows uses a wholly different
// detect-and-abort arm (lstat/fstat bigint identity), so the procfs-absence
// pin is meaningless there and is skipped loudly rather than faked.
const PROCFS_WIN32_SKIP = process.platform === 'win32' ? 'procfs is Linux-only — native Windows uses the lstat/fstat detect-and-abort arm per decision 2a69a8d7, not a /proc/self/fd preflight' : false;

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-secio1-'));
  const runId = 'r-h17si1-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  const brief = store.create(briefRecord());
  store.createRun({
    id: runId,
    brief_ref: brief.id,
    branch: 'sterling/' + runId,
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });

  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      try {
        store.close();
      } catch {}
      closed = true;
    }
  };
  const cleanup = (extraPaths = []) => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true, recursive: true });
  };
  return { dir, store, runId, dbPath, projectTag, closeStore, cleanup };
}

function tempRecords(projectTag) {
  let names = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(`sterling-enforce-${projectTag}`)).map((n) => join(tmpdir(), n));
}

function h17(dir, event, over = {}, envOverride) {
  return runHook(
    'h17-bash-write-sweep.mjs',
    {
      session_id: 's1',
      transcript_path: join(dir, 'transcripts', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; the fixtures do the mutating
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir,
    envOverride
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

const BUNDLE_REL = 'hooks/h3-contract-gate.mjs';
function bundlePath(dir) {
  return join(dir, ...BUNDLE_REL.split('/'));
}
function preDirtyBundle(dir, bytes) {
  const p = bundlePath(dir);
  writeFileSync(p, bytes);
  return p;
}

// #########################################################################
// PIN-SLICE1-PROCFS-ABSENT-HARD-DENY — Ruling C
// #########################################################################
//
// TESTABILITY DISCLOSURE (stated honestly, per the work order): this test
// cannot unmount /proc/self/fd inside a child process — that needs root and a
// mount-namespace change, neither available nor safe to do from a test
// runner, and it would not be reliably reversible on a shared CI host. There
// is no honest way to construct genuine procfs-absence without an
// implementation seam, so this pin SPECIFIES the seam the Slice 1 coder must
// add rather than fake the condition:
//
//   REQUIRED SEAM: the Linux preflight (and the /proc/self/fd/<fd>/<name>
//   path-building the no-follow-open helpers do) must resolve the procfs
//   anchor through an overridable constant, e.g.:
//
//       const PROCFS_FD_DIR = process.env.STERLING_H17_PROCFS_FD_DIR || '/proc/self/fd';
//
//   Left unset (the production case), behavior is byte-identical to hard-
//   coding '/proc/self/fd' — this is a pure test seam, not a security
//   loosening: pointing PROCFS_FD_DIR at a path that does not exist must
//   trigger EXACTLY the same hard-deny that a genuinely unmounted procfs
//   would trigger, because presence is still verified fail-closed against
//   whatever path is configured. If the coder builds Slice 1 without this
//   seam, this pin CANNOT be exercised and must be reported back rather than
//   silently skipped or faked.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason: pointing the
// override at the REAL /proc/self/fd (still present on this host) must allow
// a normal read-only Bash lane through — proving (a) the override plumbing
// is actually wired end to end, not ignored, and (b) a bare "Pre denied" in
// the treatment arm below is legible as being ABOUT procfs absence, not "this
// hook now denies everything" or "the override was never consulted".
//
// EXPECTED FAILURE SHAPE TODAY (RED — Slice 1 is not built yet, and per the
// work order the seam itself does not exist on HEAD): BOTH arms are expected
// to fail today, but for different, diagnostic reasons. The CONTROL arm's
// `assert.equal(control.code, 0, ...)` should still hold on HEAD, since an
// unrecognized environment variable is inert — HEAD has no preflight at all,
// so nothing procfs-related denies a normal read-only lane either way. The
// TREATMENT arm's `assert.equal(treatment.code, 2, ...)` fires with actual 0
// (HEAD has no preflight, so a nonexistent override path changes nothing —
// the lane simply proceeds and allows), and the stderr-message assertion
// fires on an empty/unrelated stderr. Both are the expected shape of "the
// mechanism this pin needs does not exist yet".
//
// SABOTAGE (once Slice 1 lands the preflight): delete the fail-closed branch
// (`if (!existsSync(PROCFS_FD_DIR)) { denyHard('secure I/O unavailable:
// /proc/self/fd absent'); }`) — or, more subtly, keep the branch but replace
// its hard-deny with a warn-and-continue / fall through to an lstat/fstat
// detection path (the auto-degrade decision 532a4383 explicitly rejected).
// Either one-line change must turn the TREATMENT arm's assertions red again
// (actual 0 instead of 2, or a missing/different stderr message); the
// CONTROL arm's assertion must stay green under this sabotage (it never
// touches the real /proc/self/fd), which is what proves the deny is really
// about the ABSENCE condition and not a blanket refusal.
// #########################################################################

test(
  'PIN-SLICE1-PROCFS-ABSENT-HARD-DENY: CONTROL — with the procfs probe path pointing at the REAL /proc/self/fd, Pre allows a normal read-only Bash lane',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const L = lane('procfs-control');
      const control = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: '/proc/self/fd' });
      assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        control.code,
        0,
        `CONTROL: pointing the override at the real, present /proc/self/fd must allow a normal read-only lane — this is what proves the override is actually consulted rather than ignored, and that the treatment arm's deny below is about ABSENCE, not a blanket refusal — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-PROCFS-ABSENT-HARD-DENY: with the procfs probe path pointing at a path that does not exist, Pre HARD-DENIES naming "secure I/O unavailable: /proc/self/fd absent" — never auto-degrades',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const missingProcfs = join(tmpdir(), 'sterling-h17-no-procfs-' + randomUUID().slice(0, 8));
    try {
      assert.equal(existsSync(missingProcfs), false, 'PRECONDITION: the simulated procfs anchor genuinely does not exist on disk');

      const L = lane('procfs-absent');
      const treatment = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: missingProcfs });

      assert.notEqual(treatment.code, 1, 'a security gate never fails with a non-blocking exit 1 — an unavailable prevention mechanism must be a loud deny, never a silent non-blocking warning');
      assert.equal(
        treatment.code,
        2,
        `Ruling C: an absent procfs anchor must HARD-DENY (Pre exit 2), never auto-degrade to lstat/fstat detection — actual ${treatment.code}, stderr: ${oneLine(treatment.stderr)}`
      );
      assert.ok(
        oneLine(treatment.stderr).includes('secure I/O unavailable: /proc/self/fd absent'),
        `the denial must name the precise error 'secure I/O unavailable: /proc/self/fd absent' — actual stderr: ${oneLine(treatment.stderr)}`
      );
    } finally {
      cleanup();
      rmSync(missingProcfs, { force: true, recursive: true });
    }
  }
);

// #########################################################################
// PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE — Ruling B, the (A) STATE SURFACE
// #########################################################################
//
// See the file header for why the (B) baseline surface's existing "deny a
// symlink on sight" pins (h17-baseline-symlink.test.mjs) do NOT already cover
// this, and why the sibling (A)-surface pins PIN-TYPE / PIN-LINK
// (h17-pre-state-snapshot.test.mjs) do not either: PIN-LINK's own frozen
// PRECONDITION establishes that Pre currently ALLOWS observing an
// already-symlink pre-dirty path, and it only denies at Post when the
// symlink is RE-POINTED to a different target. Neither sibling exercises a
// symlink that is IDENTICAL — same target, untouched — at both checkpoints,
// which is the one fixture that discriminates "compare readlink value, allow
// if equal" (today's plausible design) from "a symlink's state is
// UNATTESTABLE, never confirmed unchanged, always deny" (Ruling B).
//
// CONTROL ARM FIRST, established WITHIN this file's own fixture rather than
// assumed from a sibling file, so the treatment arm's denial is legible as
// being ABOUT the symlink specifically: a pre-dirty REGULAR file, left
// byte-for-byte UNCHANGED across the window, must ALLOW at Post — proving
// this fixture's hook invocation does not deny unconditionally.
//
// TREATMENT: the pre-dirty enforcement path is a SYMLINK at Pre, pointing at
// an out-of-repo target holding known bytes. Inside the window, NOTHING
// touches either the symlink or its target — same link, same target path,
// same bytes at the target, verified by PRECONDITION immediately before Post
// runs. Under Ruling B this must still DENY: the symlink's target state was
// never attestable, so it can never be reported "unchanged", regardless of
// whether it, in fact, did not change.
//
// EXPECTED FAILURE SHAPE TODAY (inferred from the spec and from PIN-LINK's
// frozen precondition — NOT measured against the hook source, which H4
// forbids reading, and NOT executed, since this role holds no Bash). The
// plausible current design compares the readlink target as an equality-
// checked state term (this is what PIN-LINK's docstring implies: "the
// readlink TARGET is the only term that differs" when it denies on retarget —
// implying an unretargeted symlink's target term is judged EQUAL). If so,
// Post treats this fixture's untouched symlink as "unchanged" and ALLOWS,
// so `assert.equal(post.code, 2, ...)` fires with actual 0.
//
// SABOTAGE (once Slice 1's classify layer reports symlink states as
// unattestable and the comparison denies unconditionally on either endpoint
// being a symlink): reintroduce a target-equality shortcut — e.g. "if
// (preState.kind === 'symlink' && postState.kind === 'symlink' &&
// preState.target === postState.target) return UNCHANGED;" ahead of the
// unattestable-always-deny rule. That one-line reintroduction must turn this
// pin red again (actual 0). The control arm's assertion must stay green under
// this sabotage — it is a plain regular-file comparison the sabotage never
// touches — which is what shows the deny in the treatment arm is about the
// symlink term specifically, not a general miscomparison.
// #########################################################################

test(
  'PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE: CONTROL — a pre-dirty REGULAR enforcement file, byte-unchanged across the window, allows at Post',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const bytes = '// conductor rebuild, not yet committed, and never touched again\n';
      const bundle = preDirtyBundle(dir, bytes);

      const L = lane('unattestable-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of a real regular pre-dirty file succeeds');

      assert.equal(readFileSync(bundle, 'utf8'), bytes, 'PRECONDITION: the file is left completely untouched across the window');

      const post = h17(dir, 'PostToolUse', L);
      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        0,
        `CONTROL: an unchanged pre-dirty REGULAR file must allow — this is what proves the treatment arm's denial below is about the SYMLINK term, not a blanket refusal in this fixture — actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE: a pre-dirty enforcement path that is a SYMLINK, IDENTICAL and untouched at both checkpoints, still DENIES — the target state is never attested as unchanged',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const decoy = join(tmpdir(), 'sterling-h17-secio1-decoy-' + randomUUID().slice(0, 8));
    try {
      const decoyBytes = Buffer.from('OUTSIDE-REPO TARGET — never modified, never re-pointed, present unchanged at both checkpoints\n');
      writeFileSync(decoy, decoyBytes);

      const bundle = bundlePath(dir);
      rmSync(bundle, { force: true });
      symlinkSync(decoy, bundle); // pre-dirty AND already a symlink at Pre — matches PIN-LINK's own frozen precondition shape

      const L = lane('unattestable-treatment');
      assert.equal(
        h17(dir, 'PreToolUse', L).code,
        0,
        "Pre snapshot of an already-symlink pre-dirty path succeeds (matches PIN-LINK's frozen precondition in h17-pre-state-snapshot.test.mjs — this file does not contradict it)"
      );

      // inside the window: literally nothing touches the symlink or its target.
      assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: still a symlink, untouched');
      assert.equal(readlinkSync(bundle), decoy, 'PRECONDITION: still pointing at the SAME target path');
      assert.deepEqual(readFileSync(decoy), decoyBytes, 'PRECONDITION: the target bytes are byte-identical to what Pre observed');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        2,
        `Ruling B: a symlink's target state is UNATTESTABLE — it must never be confirmed "unchanged", even when it demonstrably did not change — so this must deny, actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );
      assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'a denial on already-pre-existing dirt is never reverted (decision f76d7c5c) — the symlink itself must be left exactly as found');
      assert.equal(readlinkSync(bundle), decoy, 'and still pointing at the same target — no restore attempt re-points or replaces it');
      assert.deepEqual(readFileSync(decoy), decoyBytes, 'the out-of-repo target is byte-unchanged throughout');
    } finally {
      cleanup([decoy]);
    }
  }
);

// #########################################################################
// #########################################################################
// ADDENDUM — TWO PINS ADDED AFTER SLICE 1 LANDED
// #########################################################################
// #########################################################################
//
// The file header above predates this addendum and describes only the two
// original pins; it is left untouched deliberately (frozen-test discipline —
// no existing assertion or disclosure in this file is edited). The two pins
// below were authored AFTER Slice 1's implementation landed and its 107-test
// suite went green, closing two defects an INDEPENDENT REVIEWER found in code
// that the green suite had already passed. Both are therefore hollow-suite
// evidence in the sense of decision 23afbc83: the suite was green and pinned
// neither behavior.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs, same as the rest
// of this file — H4 forbids reading it, and no line of it was read. Every
// statement below about the CURRENT implementation is sourced from the work
// order's reviewer findings, never from the hook source, and is labelled as
// such where it matters. Per decision 23afbc83 the mutations named here are
// DESIGNED, never EXECUTED, by this author.
// #########################################################################

// The procfs pins below need a REAL /proc/self/fd on the host to have a
// meaningful control arm. On a host without one, the control would be
// vacuous and the treatment unattributable, so both skip loudly (P5) rather
// than assert into a fog. Distinct from PROCFS_WIN32_SKIP, which covers the
// platform that deliberately runs a different arm entirely (2a69a8d7).
const PROCFS_HOST_SKIP = (() => {
  try {
    return existsSync('/proc/self/fd') ? false : 'this host has no /proc/self/fd — the CONTROL arm (a WORKING procfs anchor still allows) cannot be established, so the treatment arm would not be attributable';
  } catch (e) {
    return `/proc/self/fd is not probeable on this host (${e.code ?? e.message})`;
  }
})();

// Finding 2's fixture needs a DIRECTORY symlink specifically. SYMLINK_SKIP
// above probes a FILE symlink, which is a different privilege on native
// Windows, so this is a separate probe rather than a reuse.
const DIR_SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-h17-dirsymprobe-'));
    mkdirSync(join(d, 'real'), { recursive: true });
    symlinkSync(join(d, 'real'), join(d, 'link'), 'dir');
    const ok = lstatSync(join(d, 'link')).isSymbolicLink() && existsSync(join(d, 'link', '.'));
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'directory symlinks are not observable on this host';
  } catch (e) {
    return `directory symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

// #########################################################################
// PIN-SLICE1-PROCFS-PRESENT-BUT-WRONG-HARD-DENY — Ruling C, the FAIL-OPEN
// #########################################################################
//
// WHY THIS PIN EXISTS, AND WHY THE EXISTING PINS MISSED IT. Ruling C
// (decision 532a4383): on Linux, when the procfs fd directory is unavailable,
// H17 HARD-DENIES. Auto-degrading to weaker detection was EXPLICITLY REJECTED
// on P5 grounds — "an unexpected environment that removes prevention must
// halt, not degrade silently". The sibling pin above covers exactly one shape
// of "unavailable": the anchor path DOES NOT EXIST (deny). The rest of the
// suite covers the other extreme: a real, working anchor (allow). Nothing
// covered the shape BETWEEN them, and that is where the reviewer found a
// FAIL-OPEN.
//
// THE DEFECT (reviewer finding, work order; NOT read from the hook by this
// author): the implementation's availability probe is `existsSync(
// PROCFS_FD_DIR)` — a PRESENCE test, not a WORKING test. So an anchor that is
// PRESENT BUT WRONG — the seam pointed at any existing directory, e.g. /tmp,
// which is the exact shape of a host whose procfs is not functioning —
// PASSES the probe as "available". Every anchored path then resolves under
// that wrong directory to a path that does not exist; every component
// classifies as `absent`; and `absent` is explicitly NOT A VIOLATION. The
// ancestor guard therefore judges EVERY path freshly creatable and the whole
// mechanism DEGRADES TO ALLOW — the precise auto-degrade Ruling C rejected,
// arrived at by accident rather than by design, and silently.
//
// THE COMMENT LIED — this is why the pin exists. The work order reports that
// the implementation carries a code comment claiming "a wrong value denies
// rather than degrades". That disclosure is PROVABLY FALSE against today's
// code: a wrong-but-present value degrades to ALLOW. This pin is not here
// because the behavior was undocumented; it is here because the code
// DOCUMENTED THE OPPOSITE OF WHAT IT DOES, and a green 107-test suite plus a
// reassuring comment is exactly the combination that stops anyone looking.
// The next reader should trust this pin's verdict over that comment.
//
// ASSERTION IS ABOUT THE OUTCOME, NOT THE PROBE. This pin says nothing about
// HOW availability is established — not existsSync, not a readdir, not an
// openSync round-trip through the anchor. It asserts only what Ruling C
// specifies observably: a DENIAL (Pre exit 2) plus the ruling's own named
// REASON ('secure I/O unavailable'). Any implementation that genuinely
// verifies the anchor works — by whatever means — satisfies it.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason. The verdict
// "Pre denied" has more than one possible cause: procfs unavailability, an
// override the code refuses on principle, or a fixture that denies
// everything. The control points the SAME seam at the REAL, WORKING
// /proc/self/fd and requires an ALLOW — so a green treatment always carries
// its evidence: the seam is consulted, it is not a poison pill, and the deny
// is attributable to the anchor being WRONG. (It duplicates the sibling
// PROCFS-ABSENT control by design, not by oversight: a pin's evidence has to
// live inside the pin, or a later edit to a neighbouring test silently
// removes this one's attribution.)
//
// EXPECTED FAILURE SHAPE TODAY (RED against HEAD): the CONTROL arm PASSES
// today (a working anchor already allows — that is the behavior the 107-test
// suite covers). The TREATMENT arm FAILS on
// `assert.equal(res.code, 2, ...)` with ACTUAL 0 — HEAD's presence-only probe
// accepts the empty directory as available, every anchored path resolves
// absent, nothing is judged a violation, and Pre ALLOWS. The stderr
// assertion behind it would fire on empty/unrelated stderr, but the exit-code
// assertion is the one that reports.
//
// SABOTAGE (once the fix lands) — the ONE-LINE change that must flip this
// pin RED: revert the anchor check to presence-only, i.e. replace whatever
// working-anchor verification the fix introduces with `if (!existsSync(
// PROCFS_FD_DIR)) denyHard(...)` and nothing more. Under that one line the
// TREATMENT must go red (actual 0 — the empty directory passes as available
// and the lane allows) while BOTH the CONTROL arm and the sibling
// PROCFS-ABSENT pin stay GREEN. That asymmetry is the whole proof: it shows
// this pin binds the PRESENT-BUT-WRONG case specifically and is not a
// re-statement of the absent case. SUBTLER SECOND SABOTAGE, which must also
// flip it red: keep the verification but replace its hard-deny with a
// warn-and-continue or a fall-through to lstat/fstat detection — the
// auto-degrade 532a4383 rejected by name.
//
// WHICH GUARD CARRIES THE VERDICT — stated as a LIMIT, not a claim. This
// author cannot say whether the fix's anchor verification is the ONLY layer
// that would deny here, because establishing that requires reading the hook
// (H4 forbids) or running the mutation (23afbc83 reserves that to the
// conductor). If the treatment stays GREEN under the first sabotage above,
// that is NOT automatically defense-in-depth: strip every candidate layer
// before concluding, and record which one actually carries the verdict. A
// pin that survives its own named sabotage with no second layer identified is
// hollow, and this one would be no exception.
//
// KNOWN LIMIT OF THE FIXTURE, disclosed rather than buried: the wrong anchor
// used below is an EMPTY existing directory. That is the shape the reviewer
// measured and the shape guaranteed to be red today (every anchored join
// resolves ENOENT -> `absent` -> allow). It does mean a WEAK fix — e.g.
// `readdirSync(PROCFS_FD_DIR).length > 0` — would satisfy this pin without
// verifying anything. A harder variant (a present directory populated with
// NUMERIC-NAMED decoy entries that are regular files, so the anchored join
// fails ENOTDIR rather than ENOENT) is deliberately NOT added here: its
// colour against today's code cannot be predicted without reading the
// classifier, and a frozen pin whose red/green state is unknown is worse than
// none. It is the right hardening to add once the fix's shape is visible.
// #########################################################################

test(
  'PIN-SLICE1-PROCFS-PRESENT-BUT-WRONG-HARD-DENY: CONTROL — with the procfs anchor pointing at the REAL, WORKING /proc/self/fd, Pre allows an ordinary read-only Bash lane',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const L = lane('procfs-wrong-control');
      const control = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: '/proc/self/fd' });
      assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        control.code,
        0,
        `CONTROL: a WORKING procfs anchor must allow an ordinary read-only lane. This arm must pass for the OPPOSITE reason to the treatment arm below — it is what makes that arm's denial legible as being about an anchor that does not WORK, rather than "the seam is a poison pill" or "this fixture denies everything" — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-PROCFS-PRESENT-BUT-WRONG-HARD-DENY: with the procfs anchor pointing at a directory that EXISTS but is not a working procfs fd directory, Pre HARD-DENIES — it must not classify every path as absent and allow',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    // An existing-but-wrong anchor, created inside this file's own tmpdir
    // handling like every other fixture here — no new top-level temp path.
    const wrongProcfs = mkdtempSync(join(tmpdir(), 'sterling-h17-wrong-procfs-'));
    try {
      assert.equal(existsSync(wrongProcfs), true, 'PRECONDITION: the wrong anchor EXISTS — a presence-only probe would accept it as "available"');
      assert.equal(readdirSync(wrongProcfs).length, 0, 'PRECONDITION: and it is not a working procfs fd directory — it holds no fd entries at all, so every anchored /<fd>/<name> path under it resolves to nothing');

      const L = lane('procfs-wrong-treatment');
      const res = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: wrongProcfs });

      assert.notEqual(res.code, 1, 'a security gate never fails with a non-blocking exit 1 — an unusable prevention mechanism must be a loud deny, never a silent non-blocking warning');
      assert.equal(
        res.code,
        2,
        `Ruling C (decision 532a4383): a procfs anchor that is PRESENT BUT NOT WORKING is UNAVAILABLE, and unavailable means HARD-DENY. It must never resolve every anchored path to a nonexistent location, classify each component 'absent', judge nothing a violation and thereby DEGRADE TO ALLOW — that is the auto-degrade the ruling rejected by name, reached silently. Actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
      assert.ok(
        oneLine(res.stderr).includes('secure I/O unavailable'),
        `the denial must state the reason Ruling C names — 'secure I/O unavailable' — so an operator can tell a security refusal from a contract violation; the exact suffix is the implementation's to choose, the reason is not. Actual stderr: ${oneLine(res.stderr)}`
      );
    } finally {
      cleanup();
      rmSync(wrongProcfs, { force: true, recursive: true });
    }
  }
);

// #########################################################################
// PIN-SLICE1-SYMLINKED-REPO-ROOT-STILL-ALLOWS — the NEW FALSE DENY
// #########################################################################
//
// WHY THIS PIN EXISTS. Slice 1's classifyPathComponents opens the anchor
// with O_DIRECTORY|O_NOFOLLOW on the REPO ROOT (reviewer finding, work order;
// NOT read from the hook by this author). If `input.cwd` is ITSELF a symlink
// — the entirely ordinary `~/proj -> /mnt/data/proj` arrangement — that open
// throws ELOOP, lands on the fail-closed catch, and EVERY agent Bash call is
// DENIED. The pre-slice code never lstat'd cwd itself, so this is a NEW
// availability regression, not a pre-existing one. This cluster has already
// been REVERTED TWICE over false denies; an availability regression here is
// the failure mode with the worst track record in this file's territory.
//
// WHAT THIS PIN DOES NOT SAY — the conflation to avoid. Ruling B (532a4383)
// makes symlink TARGET STATES unattestable: a symlink's target is never read
// through and never confirmed unchanged, which is exactly what the
// PIN-SLICE1-SYMLINK-TARGET-UNATTESTABLE pins above hold, and this pin does
// not weaken that by a hair. Ruling B says nothing whatever about the
// PROJECT ROOT one reaches the repo through. "A symlinked path is not
// attestable as a protected file's state" and "a symlinked project root
// makes the tool unusable" are different claims, and only the first was
// ruled. A guard that refuses to attest a symlink's target while still
// FUNCTIONING under a symlinked root satisfies both pins simultaneously —
// which is the point.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason. "Pre allowed"
// under a symlinked root is only meaningful if this fixture's command and
// lane are allowable AT ALL. The control runs the identical ordinary
// read-only command through the identical fixture with a NON-symlinked root
// and requires an ALLOW — so if both arms ever go red together the cause is
// the fixture, and if only the treatment goes red the cause is the symlinked
// root. Without it a green treatment could equally mean "this hook allows
// everything", which is precisely the fail-open the pin above exists to
// catch, and the two must stay independently diagnosable.
//
// EXPECTED FAILURE SHAPE TODAY (RED against HEAD): the CONTROL arm PASSES
// today (an ordinary root already allows an ordinary read-only command). The
// TREATMENT arm FAILS on `assert.equal(pre.code, 0, ...)` with ACTUAL 2 —
// the O_NOFOLLOW open of the symlinked root throws ELOOP, the fail-closed
// catch converts it to a deny, and Pre exits 2 before the Post arm is ever
// reached. (The Post assertion that follows is therefore unreached today;
// it is present because "allowed" for an ordinary command means allowed at
// BOTH checkpoints, not merely un-denied at the first.)
//
// SABOTAGE (once the fix lands) — the ONE-LINE change that must flip this
// pin RED: reinstate O_NOFOLLOW on the repo-root anchor open, i.e. restore
// `openSync(root, O_DIRECTORY | O_NOFOLLOW)` for the cwd/root anchor
// specifically. Under that one line the TREATMENT must go red (actual 2 —
// ELOOP into the fail-closed catch) while the CONTROL stays GREEN (a real
// directory root opens fine with or without O_NOFOLLOW). That asymmetry is
// the evidence: it shows the pin binds the SYMLINKED-ROOT case and is not
// just observing that the hook allows things.
//
// WHICH GUARD CARRIES THE VERDICT — a LIMIT, not a claim, same as above.
// Whether the root anchor's open is the only place a symlinked cwd can
// produce ELOOP cannot be established without reading the hook (H4) or
// running the mutation (23afbc83). If the treatment stays GREEN under that
// sabotage, strip every candidate layer before calling it defense-in-depth,
// and record which one actually carries the verdict.
//
// FIXTURE NOTE: the symlink is created inside this file's own tmpdir
// handling and torn down through makeGitProject's own `cleanup(extraPaths)`,
// with a defensive sweep of any temp enforcement record keyed to the
// UNRESOLVED link path — the article states H17 realpaths cwd before keying
// that file, so the tag SHOULD match the plain fixture's; the sweep costs
// nothing and prevents a leaked record if it does not.
// #########################################################################

test(
  'PIN-SLICE1-SYMLINKED-REPO-ROOT-STILL-ALLOWS: CONTROL — an ordinary read-only command under an ORDINARY (non-symlinked) project root is allowed at both checkpoints',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const L = lane('symroot-control');

      const pre = h17(dir, 'PreToolUse', L);
      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        0,
        `CONTROL: an ordinary read-only command under an ordinary root must be allowed at Pre — this arm passes for the OPPOSITE reason to the treatment arm, and is what makes a treatment failure attributable to the SYMLINKED ROOT rather than to this fixture's command or lane — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      const post = h17(dir, 'PostToolUse', L);
      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 0, `CONTROL: and allowed at Post, with nothing on disk changed — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-SYMLINKED-REPO-ROOT-STILL-ALLOWS: with the project root reached through a SYMLINKED path, an ordinary allowed command is still ALLOWED — a symlinked root must not deny every agent Bash',
  { skip: GIT_SKIP || DIR_SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const linkRoot = join(tmpdir(), 'sterling-h17-symroot-' + randomUUID().slice(0, 8));
    try {
      symlinkSync(dir, linkRoot, 'dir'); // the ordinary `~/proj -> /mnt/data/proj` arrangement
      assert.equal(lstatSync(linkRoot).isSymbolicLink(), true, 'PRECONDITION: the project root handed to the hook is ITSELF a symlink');
      assert.equal(realpathSync(linkRoot), realpathSync(dir), 'PRECONDITION: and it resolves to the very same real project — nothing about the repo differs from the CONTROL arm except the path used to reach it');
      assert.equal(existsSync(join(linkRoot, 'src', 'feature.ts')), true, 'PRECONDITION: the repo contents are reachable through the symlinked root');

      const L = lane('symroot-treatment');

      // cwd in the payload AND the spawned process is the SYMLINK, not the
      // real path — that is the whole condition under test.
      const pre = h17(linkRoot, 'PreToolUse', L);
      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        0,
        `A symlinked project root must not make the tool unusable. Ruling B (532a4383) makes symlink TARGET STATES unattestable — it says nothing about the path one reaches the REPO ROOT through, and a no-follow open of the root that throws ELOOP into the fail-closed catch converts the ordinary ~/proj -> /mnt/data/proj arrangement into a total denial of every agent Bash. Actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      const post = h17(linkRoot, 'PostToolUse', L);
      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        0,
        `and allowed at POST too — "allowed" for an ordinary read-only command means allowed at BOTH checkpoints; a Pre that permits and a Post that denies is the same availability regression moved one step later. Actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );
    } finally {
      const rawTag = createHash('sha256').update(linkRoot).digest('hex').slice(0, 16);
      cleanup([linkRoot]);
      for (const p of tempRecords(rawTag)) rmSync(p, { force: true });
    }
  }
);

// #########################################################################
// #########################################################################
// ADDENDUM 2 — PINS FROM THE OUTSIDE-FAMILY (CODEX) REVIEW
// #########################################################################
// #########################################################################
//
// A second, outside-family review landed after the addendum above and found
// more in the same green-107-suite code. Same discipline throughout: authored
// BLIND to scripts/hooks/h17-bash-write-sweep.mjs (H4 — not one line of it
// read), every statement about the current implementation sourced from the
// reviewer findings in the work order and labelled as such, every mutation
// DESIGNED and never EXECUTED (decision 23afbc83), no existing assertion in
// this file altered.
//
// TWO OF THE FOUR FINDINGS ARE NOT PINNED HERE, DELIBERATELY, and the
// reasons are written into this file rather than left in a report — see
// "NOT PINNED" at the bottom of this addendum. An honest gap that the next
// reader can see beats a pin that goes green for a reason nobody checked,
// which is the very defect one of those findings is about.
// #########################################################################

// Raw-stdin variant of runHook: FINDING A is about what the hook does with
// stdin that is not valid JSON, so the payload cannot go through
// JSON.stringify on the way in.
function runHookRawStdin(script, rawStdin, cwd, envOverride) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: rawStdin,
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
    env: envOverride ? { ...process.env, ...envOverride } : process.env,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// The payload h17() builds, exposed as a value so the raw-stdin arms can
// serialize it themselves (and then damage the serialization). Deliberately a
// separate function rather than a refactor of h17() — h17() is load-bearing
// for the frozen pins above and is not touched.
function rawInput(dir, event, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 'transcripts', 's1.jsonl'),
    cwd: dir,
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'grep -rn "resolveRun" scripts/' },
    ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
    ...over,
  };
}

// FINDING C's anti-hardcode arm needs a procfs fd directory that WORKS but is
// NOT the literal string '/proc/self/fd'. /proc/thread-self/fd is exactly
// that: a real, working fd directory (the fd table is per-process, so it
// lists the same descriptors), reached — like /proc/self — through a magic
// symlink, so it demands nothing of an implementation that /proc/self/fd does
// not already demand.
const PROCFS_ALIAS = '/proc/thread-self/fd';
const PROCFS_ALIAS_SKIP = (() => {
  try {
    return existsSync(PROCFS_ALIAS) ? false : `${PROCFS_ALIAS} is not present on this host — the anti-hardcode arm needs a SECOND working procfs fd directory and will not fake one`;
  } catch (e) {
    return `${PROCFS_ALIAS} is not probeable on this host (${e.code ?? e.message})`;
  }
})();

// #########################################################################
// PIN-SLICE1-MALFORMED-STDIN-DENIES — FINDING A (HIGH): a fail-open BEFORE
// the boundary, which makes every other pin in this file conditional
// #########################################################################
//
// THE DEFECT (reviewer finding, work order; NOT read from the hook by this
// author): readStdin() is called OUTSIDE any catch that guarantees exit 2,
// and readStdin's own readFileSync/JSON.parse is unguarded. Malformed or
// truncated stdin therefore THROWS out of the top of the hook, Node exits
// non-2, and the hook runner reads a non-2 exit as ALLOW. Nothing downstream
// runs: not the Ruling C preflight, not the sweep, not one line of the
// classify layer.
//
// WHY THIS PIN COMES BEFORE THE OTHERS IN IMPORTANCE. Every pin above asserts
// what H17 does once it has parsed its input. This one asserts that failing
// to parse its input is itself a denial. Without it, the Ruling C refusal is
// NOT reliably the first thing an agent command meets — there is an earlier
// door, and today it opens. A gate whose input parser fails open has no
// guarantees at all downstream of it, however well pinned they are.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason: the SAME raw-
// stdin harness, handed WELL-FORMED bytes for an ordinary allowed command,
// must exit 0. Without it, "exit 2 on garbage" is unattributable — it would
// be satisfied identically by a harness that mis-spawns the hook, by a hook
// that denies every raw-stdin call, and by a fixture that denies everything.
// The control is the thing that makes the treatment's 2 mean "the hook parsed
// nothing and therefore refused", not "this spawn never works".
//
// EXPECTED FAILURE SHAPE TODAY (RED against HEAD): the CONTROL arm PASSES.
// Both TREATMENT arms fail on the FIRST assertion,
// `assert.notEqual(res.code, 1, ...)`, with ACTUAL 1 — an uncaught throw out
// of JSON.parse gives Node's uncaught-exception exit code 1, which is the
// non-blocking code the hook runner treats as ALLOW. (If a future HEAD exits
// 0 instead, the notEqual passes and the following `assert.equal(res.code, 2)`
// reports with actual 0; either way the pin is red today, and both shapes say
// the same thing: the parse failure did not become a denial.)
//
// SABOTAGE — the ONE-LINE change that must flip these arms RED once fixed:
// remove the guard around the stdin read, i.e. take the readStdin() call back
// out of the try that guarantees exit 2 (or delete the `catch { denyHard(...)
// }` that wraps the parse). Under that one line BOTH treatment arms must go
// red (actual 1) while the CONTROL stays GREEN — well-formed stdin never
// enters the catch. That asymmetry is the evidence that these arms pin the
// PARSE-FAILURE path and not "the hook denies raw-stdin calls".
//
// WHICH GUARD CARRIES THE VERDICT — a LIMIT, not a claim: whether the fix's
// outer catch is the only thing that could produce a 2 here cannot be
// established without reading the hook (H4) or running the mutation
// (23afbc83). If a treatment arm survives the sabotage, strip every candidate
// layer before calling it defense-in-depth, and record which one carries it.
// #########################################################################

test(
  'PIN-SLICE1-MALFORMED-STDIN-DENIES: CONTROL — the same raw-stdin harness, given WELL-FORMED input for an ordinary allowed command, exits 0',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const raw = JSON.stringify(rawInput(dir, 'PreToolUse', lane('rawstdin-control')));
      assert.doesNotThrow(() => JSON.parse(raw), 'PRECONDITION: the control arm really is handing the hook valid JSON');

      const res = runHookRawStdin('h17-bash-write-sweep.mjs', raw, dir);
      assert.notEqual(res.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        res.code,
        0,
        `CONTROL: valid stdin on an ordinary read-only command must be allowed. This arm passes for the OPPOSITE reason to the treatment arms below and is what makes their exit 2 legible as "the input could not be parsed, so the gate refused" rather than "this harness never works" or "raw-stdin calls are always denied" — actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-MALFORMED-STDIN-DENIES: TRUNCATED stdin JSON must DENY (exit 2) — a hook that cannot parse its input must never exit non-2, because the runner reads non-2 as ALLOW',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const whole = JSON.stringify(rawInput(dir, 'PreToolUse', lane('rawstdin-truncated')));
      const truncated = whole.slice(0, Math.max(1, whole.length - 12)); // a stdin write cut short
      assert.throws(() => JSON.parse(truncated), 'PRECONDITION: the fixture really is unparseable JSON, not merely unusual JSON');

      const res = runHookRawStdin('h17-bash-write-sweep.mjs', truncated, dir);

      assert.notEqual(
        res.code,
        1,
        `FINDING A: an unparseable input must not escape as an uncaught throw — Node's exit 1 is a NON-BLOCKING code and the hook runner treats it as ALLOW, so the Ruling C preflight and the whole sweep are skipped and the command runs unexamined. Actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
      assert.equal(
        res.code,
        2,
        `a gate that cannot read its own input has not verified anything and must FAIL CLOSED (exit 2) — actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
      assert.notEqual(oneLine(res.stderr), '', 'and the denial must say something (P5, fail LOUD) — a silent refusal is undiagnosable for the operator who has to act on it');
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-MALFORMED-STDIN-DENIES: stdin that is not JSON at all must DENY (exit 2)',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const garbage = 'this is not json at all\n';
      assert.throws(() => JSON.parse(garbage), 'PRECONDITION: the fixture really is unparseable');

      const res = runHookRawStdin('h17-bash-write-sweep.mjs', garbage, dir);

      assert.notEqual(res.code, 1, `FINDING A: an unparseable input must not escape as an uncaught throw (exit 1 = non-blocking = ALLOW). Actual ${res.code}, stderr: ${oneLine(res.stderr)}`);
      assert.equal(res.code, 2, `a gate that cannot read its own input must fail closed — actual ${res.code}, stderr: ${oneLine(res.stderr)}`);
    } finally {
      cleanup();
    }
  }
);

// #########################################################################
// PIN-SLICE1-PROCFS-ANCHOR-NOT-HARDCODED — FINDING C, half 1: make the
// Ruling C pair discriminate "denies for the RIGHT reason"
// #########################################################################
//
// THE TEST-QUALITY DEFECT (reviewer finding): the two Ruling C tests at the
// top of this file cover exactly two points — the LITERAL real path allows,
// and a nonexistent path denies. That pair is satisfied IDENTICALLY by a
// correct implementation and by a hardcoded shortcut of the form
// `if (PROCFS_FD_DIR !== '/proc/self/fd') denyHard(...)`, which verifies
// nothing about the anchor and would deny on any working alternative. A pin
// that a stub satisfies is not pinning the behavior; it is pinning a string.
//
// THIS ARM CLOSES THAT: a procfs fd directory that WORKS but is not the
// literal '/proc/self/fd' must ALLOW. /proc/thread-self/fd is that directory
// — a real fd directory reached, exactly like /proc/self, through a magic
// symlink, so it asks nothing extra of a correct no-follow implementation.
//
// NO SEPARATE CONTROL ARM IS NEEDED HERE, and that is a judgement, not an
// omission: this arm's verdict is an ALLOW, and an allow has one interesting
// cause (the anchor was accepted and verified as working). The multi-cause
// problem the control-arm rule exists for is a DENIAL, which this arm does
// not assert. Its evidential partner is the treatment arm of
// PIN-SLICE1-PROCFS-PRESENT-BUT-WRONG-HARD-DENY above: together they say the
// anchor is judged by whether it WORKS, from both directions — wrong-but-
// present denies, right-but-differently-named allows. Neither direction alone
// distinguishes verification from string comparison.
//
// EXPECTED SHAPE TODAY: GREEN. This arm pins no defect that exists on HEAD —
// today's presence-only probe accepts any existing path, so a working
// alternative anchor already allows. It is a REGRESSION FENCE aimed at the
// FIX, and its whole value is the shape of fix it forbids. Stating this
// plainly matters: a green pin that is honestly labelled as a fence is
// useful, whereas a green pin mistaken for a defect pin is how a hollow suite
// grows.
//
// SABOTAGE — the ONE-LINE change that must flip this arm RED: implement the
// Ruling C availability check as a literal comparison,
// `if (PROCFS_FD_DIR !== '/proc/self/fd') denyHard('secure I/O unavailable
// ...')`. Under it, this arm goes red (actual 2 — a working anchor refused
// for having the wrong name) while BOTH existing Ruling C tests and the
// PRESENT-BUT-WRONG pin above stay GREEN. That is precisely the point: this
// arm is the only thing in the file that shortcut cannot satisfy.
// #########################################################################

test(
  'PIN-SLICE1-PROCFS-ANCHOR-NOT-HARDCODED: a procfs fd directory that WORKS but is not the literal "/proc/self/fd" must still ALLOW — availability is verified, not string-compared',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP || PROCFS_ALIAS_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      assert.notEqual(PROCFS_ALIAS, '/proc/self/fd', 'PRECONDITION: the alias anchor is a DIFFERENT path string from the one the implementation might hardcode');
      assert.equal(existsSync(PROCFS_ALIAS), true, 'PRECONDITION: and it is genuinely present and usable on this host');

      const res = h17(dir, 'PreToolUse', lane('procfs-alias'), { STERLING_H17_PROCFS_FD_DIR: PROCFS_ALIAS });
      assert.notEqual(res.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        res.code,
        0,
        `Ruling C denies on an anchor that is UNAVAILABLE, not on an anchor whose path spelling is unfamiliar. A working procfs fd directory must be accepted whatever it is called — an implementation that only accepts the literal '/proc/self/fd' has verified nothing and merely agrees with the two existing Ruling C tests by coincidence. Actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

// #########################################################################
// PIN-SLICE1-PROCFS-DENY-PRECEDES-IO — FINDING C, half 2: the Ruling C
// denial must happen BEFORE the hook does its enforcement-surface I/O
// #########################################################################
//
// THE TEST-QUALITY DEFECT (reviewer finding): the existing Ruling C tests
// assert only an exit code. An implementation that ran the entire sweep —
// walking and reading the enforcement surface through the very anchor it had
// not verified — and only then noticed the anchor and denied would satisfy
// them completely. Ruling C says PREFLIGHT ("fail startup preflight, deny
// agent Bash"): the refusal is supposed to be the first thing the command
// meets, not the last.
//
// THE OBSERVABLE, and it is a PROXY — stated as one rather than dressed up:
// a normal Pre run writes the per-project enforcement baseline record into OS
// temp (the record this file's own makeGitProject/cleanup helpers already
// know how to find, via tempRecords(projectTag)). That record is a product of
// the secure-I/O read path. So "no such record exists after a denied Pre" is
// observable evidence that the denial landed before the enforcement-surface
// I/O ran. What it CANNOT prove is that literally zero bytes were read
// anywhere; a hook that read the whole surface and then deleted its own
// record would fool it. Pinning that stronger claim needs an I/O-accounting
// seam nobody has asked for, and this proxy is chosen deliberately over
// asserting nothing.
//
// CONTROL ARM FIRST, and it is ESSENTIAL here rather than decorative: "no
// record was found" has a second, boring cause — a fixture that never writes
// a record at all, in which case the treatment arm passes vacuously forever.
// The control runs the identical fixture with a WORKING anchor and requires
// that a record IS written. It must pass for the opposite reason, and it is
// the only thing standing between this pin and permanent vacuity.
//
// EXPECTED FAILURE SHAPE TODAY (RED against HEAD): the CONTROL arm PASSES
// (a working anchor allows, and Pre writes its baseline record). The
// TREATMENT arm fails on `assert.equal(after.length, 0, ...)` with a nonzero
// count — today the wrong-but-present anchor is accepted as available, the
// sweep runs to completion, the baseline record is written and the lane is
// ALLOWED, so both the record and the allow are exactly what should not
// exist. (Its preceding `assert.equal(res.code, 2)` also fails today, actual
// 0, for the same root cause as PIN-SLICE1-PROCFS-PRESENT-BUT-WRONG above;
// the record assertion is the claim this pin adds, and it is the one that
// distinguishes "denied" from "denied FIRST".)
//
// SABOTAGE — the ONE-LINE change that must flip this pin RED once fixed:
// move the anchor-availability check from the preflight to the END of the
// sweep (i.e. delete the preflight call site and let the same check run just
// before the final verdict is emitted). The exit code stays 2, so every other
// Ruling C assertion in this file stays GREEN — and ONLY this pin's
// `after.length === 0` goes red, because the record was written on the way
// through. A pin that no other pin's sabotage can move is the definition of
// one that is carrying its own weight.
// #########################################################################

test(
  'PIN-SLICE1-PROCFS-DENY-PRECEDES-IO: CONTROL — with a WORKING anchor, Pre allows AND writes its enforcement baseline record (so "no record" below is not vacuous)',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP },
  () => {
    const { dir, projectTag, cleanup } = makeGitProject();
    try {
      assert.equal(tempRecords(projectTag).length, 0, 'PRECONDITION: this project has no enforcement baseline record before Pre runs');

      const res = h17(dir, 'PreToolUse', lane('procfs-io-control'), { STERLING_H17_PROCFS_FD_DIR: '/proc/self/fd' });
      assert.equal(res.code, 0, `CONTROL: a working anchor allows — actual ${res.code}, stderr: ${oneLine(res.stderr)}`);
      assert.ok(
        tempRecords(projectTag).length > 0,
        'CONTROL: and a normal Pre DOES write an enforcement baseline record for this project. This arm must pass for the OPPOSITE reason to the treatment arm: without it, the treatment\'s "no record was written" could mean the denial came first OR simply that this fixture never writes records at all, and the pin would pass vacuously forever.'
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-PROCFS-DENY-PRECEDES-IO: with an unusable anchor, the denial lands BEFORE the enforcement-surface I/O — no baseline record is left behind',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP },
  () => {
    const { dir, projectTag, cleanup } = makeGitProject();
    const wrongProcfs = mkdtempSync(join(tmpdir(), 'sterling-h17-wrong-procfs-io-'));
    try {
      assert.equal(tempRecords(projectTag).length, 0, 'PRECONDITION: no enforcement baseline record exists before Pre runs');
      assert.equal(existsSync(wrongProcfs), true, 'PRECONDITION: the anchor EXISTS (a presence-only probe accepts it) ...');
      assert.equal(readdirSync(wrongProcfs).length, 0, 'PRECONDITION: ... and does not work — it holds no fd entries');

      const res = h17(dir, 'PreToolUse', lane('procfs-io-treatment'), { STERLING_H17_PROCFS_FD_DIR: wrongProcfs });

      assert.notEqual(res.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(res.code, 2, `Ruling C: an unusable anchor hard-denies — actual ${res.code}, stderr: ${oneLine(res.stderr)}`);

      const after = tempRecords(projectTag);
      assert.equal(
        after.length,
        0,
        `Ruling C names a PREFLIGHT: the refusal must be the FIRST thing the command meets, not the last. A baseline record left behind proves the hook walked and read the enforcement surface THROUGH the anchor it had not verified, and only then declared it unavailable — that is a denial, but it is not a preflight, and every read it performed happened without the guarantee the anchor was supposed to provide. Found ${after.length} record(s): ${after.join(', ')}`
      );
    } finally {
      cleanup();
      rmSync(wrongProcfs, { force: true, recursive: true });
    }
  }
);

// #########################################################################
// PIN-SLICE1-SWAPPED-ANCESTOR-NOT-ATTESTED — FINDING B (HIGH), and also
// FINDING C's second half (the Ruling B pins vs a naive type check)
// #########################################################################
//
// THE DEFECT (reviewer finding, work order; NOT read from the hook by this
// author): classifyPathComponents closes its pinned descriptor before
// returning and the byte readers then REOPEN BY ABSOLUTE PATH, so O_NOFOLLOW
// guards only the FINAL component and never a swapped ancestor; and pathState
// does not call the pinned classifier at all — it lstats by path, then hashes
// the same path. The named race: swap `hooks/subdir` between a real directory
// and a symlink to an outside directory, so classification observes the real
// state while the hash resolves through the swapped ancestor to a decoy.
//
// WHAT THIS PIN COVERS, AND WHAT IT DOES NOT — read this before trusting its
// green. The reviewer's race is INTRA-CALL: the swap happens between the
// classify and the read INSIDE one hook invocation. That window cannot be
// hit deterministically from a test — there is no interposition point, and
// the only honest ways to get one are an implementation seam (a pause hook)
// or a spin-loop racer, the first of which nobody has authorized and the
// second of which is a flaky test wearing a security pin's clothes. Neither
// is worth doing: a race pin that fails one run in fifty teaches the suite to
// be ignored. So this pin takes the SAME invariant — the state that gets
// attested must belong to the object that was classified — and instantiates
// it in the window the test DOES own deterministically: Pre to Post.
//   COVERED: an enforcement path whose ANCESTOR directory is replaced by a
//     symlink to an out-of-repo decoy, where the decoy presents BYTE-
//     IDENTICAL content, must not be attested "unchanged". A leaf-only lstat
//     plus a hash-by-path cannot tell the difference; a walk that pins each
//     component, or that treats a symlinked ancestor as unattestable per
//     Ruling B ("never read through"), catches it immediately.
//   NOT COVERED: the intra-call window itself. A fix that pins the descriptor
//     chain closes both, and I expect any fix that passes this pin to have
//     had to look at ancestors — but this pin does not PROVE the classify and
//     the read observe the same object across time, and it must not be cited
//     as if it did.
//   UNCHANGED BY THE 2026-08-26 FIXTURE REPAIR: the repair restores this pin's
//     ability to REACH its behavioural assertions; it neither widens nor
//     narrows the two bullets above. The Pre-to-Post instantiation is still
//     what is covered, and the intra-call classify->read window is still NOT
//     covered — it needs the interposition seam recorded under NOT PINNED (1)
//     at the foot of this file, which nobody has authorized. Stating that
//     residual is a requirement, not a caveat: it stays open.
//   UNCHANGED BY THE 2026-08-26 ASSERTION REPAIR (see "ASSERTION REPAIR" at
//     the foot of this block): that repair makes the pin DISCRIMINATE which
//     layer denied; it does not move the coverage line either. COVERAGE, AS
//     IT STANDS: this pin covers the Pre->Post INSTANTIATION of the invariant
//     only. THE INTRA-CALL classify->read WINDOW REMAINS UNCOVERED, and it is
//     not an oversight — decision dfe70090 (h17-slice1-accepted-with-named-
//     residuals, user ruling 2026-08-26) records it as RESIDUAL 3, an
//     ACCEPTED, NAMED, BOARDED residual whose structural closure is assigned
//     to SLICE 2's descriptor-pinned read/write primitives ("assertRealAncestors
//     releases its pinned descriptors before lstat/hash, which both RE-RESOLVE
//     BY PATHNAME ... THIS ONE IS DEFERRED BY DESIGN"). Nothing in this file
//     may be cited as covering it.
//
// IT ALSO CLOSES FINDING C's Ruling B half. The reviewer's point there is
// that the existing symlink pin at the top of this file would be satisfied by
// a naive `if (type === 'symlink') deny` with the marker / sameState /
// stampCouldAttest layers doing no work at all. This fixture's leaf is NOT a
// symlink at either checkpoint — it is an ordinary regular file, with
// identical bytes, both times. A leaf type check sees nothing to deny and
// allows. Only a layer that actually reasons about how the path was RESOLVED
// can produce the verdict, which is what makes those layers observably
// load-bearing here and nowhere else in this file.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason: the identical
// fixture — same nested directory, same tracked-then-pre-dirtied file, same
// bytes — with NO swap must ALLOW at Post. Without it, the treatment's deny
// is unattributable: a pre-dirty file in a subdirectory might be refused for
// reasons that have nothing to do with the ancestor (nesting, the extra
// commit, the path shape), and the pin would go green while pinning nothing.
//
// FIXTURE ISOLATION — REPAIRED 2026-08-26. Fixture mechanics and comments
// only; not one behavioural assertion in this pin was altered, added, or
// weakened.
//
// WHAT WAS WRONG. As first written, this pin asserted that whole-tree
// `git status --porcelain` reported the SAME thing before and after the swap,
// with the disclosure that a firing would be "a fixture verdict, not a defect
// verdict". IT FIRED — on this host, and by construction on every host.
// Replacing the directory `hooks/sub` with a symlink makes git report
// ` D hooks/sub/gate.mjs` plus `?? hooks/sub` where it previously reported
// ` M hooks/sub/gate.mjs`, because git never descends a symlink and therefore
// cannot see the tracked leaf at all. That delta is not a host quirk to be
// tolerated on better git versions; it is the SWAP'S OWN DEFINITION, so the
// assertion was UNSATISFIABLE. It fired identically at baseline AND under
// every mutant arm, the treatment never reached its behavioural assertion, and
// the pin rendered NO VERDICT EITHER WAY — the worst state a pin can be in,
// because it still reads as coverage while proving nothing.
//
// WHAT THE REPAIRED GUARD ASSERTS, and why this is the honest choice.
// Porcelain lines are partitioned by the fixture subtree (`hooks/sub` and
// everything under it) and the OUTSIDE partition must be identical before and
// after the swap. That quantity is genuinely invariant — the swap is confined
// to `hooks/sub` by construction — so the guard CAN hold, and it still fails
// loudly for the whole class it can see: fixture leakage into the rest of the
// repo (a clobbered hooks/hooks.json, a stray write under src/, a straddling
// or unparseable entry, and — with its own assertion in the body — a decoy
// created inside the repo instead of outside it). The alternative repair,
// moving the fixture somewhere the comparison is unconfounded, was REJECTED:
// the only such place is the gitignored (B) surface, where this pin is
// born-hollow for the separate reason in the parenthetical below.
//
// WHAT THIS GUARD CAN NO LONGER CLAIM — stated plainly, because the original
// comment claimed it and was WRONG. It does NOT isolate H17's git-status arm.
// git DOES see a change inside the fixture subtree; that change is a
// disappeared tracked enforcement file; and a guard that denies on exactly
// that would produce this pin's expected exit 2 without ever reasoning about
// ancestors. No fixture can remove the confound — any directory-to-symlink
// swap hides the tracked leaf from git — and no arm can retire it either: the
// git-visible delta is itself a genuine enforcement violation, so a "same git
// delta, no symlink" control (replace the directory with a regular file of
// the same name, which produces the identical ' D' + '??' pair) would deny
// too, and a control that must DENY carries no attribution. THE CONFOUND IS
// THEREFORE DISCLOSED, NOT ASSERTED AWAY. The one thing that can settle which
// layer carries the verdict is the mutation run under SABOTAGE below, and
// that run is now this pin's load-bearing check rather than a formality.
//
// (Why the (A) surface and not the gitignored (B) surface, where isolation
// would be free: the (B) baseline walk already denies a symlink ON SIGHT
// during its own traversal — h17-baseline-symlink.test.mjs pins that — so a
// swapped ancestor there would deny TODAY, for a reason that has nothing to
// do with this finding, and the pin would be born hollow. The (A) surface is
// where the reviewer located the defect and the only place the fixture
// discriminates.)
//
// EXPECTED FAILURE SHAPE TODAY (RED against HEAD): the CONTROL arm PASSES.
// The TREATMENT arm fails on `assert.equal(post.code, 2, ...)` with ACTUAL 0
// — today's lstat-by-path plus hash-by-path resolves straight through the
// swapped ancestor to the decoy, sees the same type and the same hash it
// recorded at Pre, and reports the enforcement path UNCHANGED. (Second
// possible shape, disclosed rather than hidden: if this host's git reports
// the swap, the isolation assertion above fires FIRST instead. That is a
// fixture verdict, not a defect verdict, and must be fixed rather than
// accepted as a pass or as a red.)
//
// EXPECTED SHAPE AFTER THE 2026-08-26 REPAIR — superseding the paragraph
// above, which is left intact as the record of what was authored. The second
// possible shape is the one that HAPPENED, and it is what the repair fixes.
// The work order also reports that the implementer's fix has since landed
// (`pathState` calls `assertRealAncestors` at depth 0, classifying the
// ancestor chain before the path is lstat'd and hashed) — so the treatment arm
// is now expected GREEN rather than red. This author has NOT executed it: this
// role holds no Bash by design, and per 23afbc83 the mutations below are
// DESIGNED, never run, here. A green treatment is therefore NOT yet evidence
// the fix works — the pin's verdict only becomes meaningful once the mutation
// run below has been executed and its result recorded, because the confound
// disclosed above admits a green with no ancestor reasoning anywhere.
//
// SABOTAGE — the ONE-LINE change that must flip this pin RED once fixed:
// restore the reopen-by-path in the byte reader for the state surface, i.e.
// hash the absolute path again instead of reading through the pinned
// descriptor chain the classifier established (equivalently: drop the
// ancestor components from what the classifier attests). Under it, the
// TREATMENT must go red (actual 0 — the decoy's identical bytes read as
// unchanged) while the CONTROL and every existing pin in this file stay
// GREEN — no other test in this file has a symlinked ancestor, so nothing
// else can move.
//
// SABOTAGE, RESTATED AFTER THE 2026-08-26 REPAIR (23afbc83 requires the named
// sabotage to stay accurate when the fixture changes). The fix that landed is
// `pathState` calling `assertRealAncestors` at depth 0, so the sabotage is now
// NAMED AGAINST IT and is one line: remove that depth-0 `assertRealAncestors`
// call from `pathState` (equivalently: start the ancestor walk at the leaf's
// parent-of-parent, or drop the ancestor components from what the classifier
// attests) so the path is lstat'd and hashed without its chain having been
// classified. Under that one line the TREATMENT must go RED (actual 0) while
// the CONTROL and every other pin in this file stay GREEN.
//
// AND THE HOLLOWNESS TEST THAT NOW MATTERS MORE THAN THE PIN'S OWN COLOUR.
// Because the git-status confound above cannot be removed by any fixture,
// THE MUTATION IS THE ONLY THING SEPARATING THIS PIN FROM A HOLLOW ONE. If
// the treatment stays GREEN under that sabotage, do NOT record it as defense
// in depth on the strength of the green: strip each remaining candidate in
// turn — (a) Ruling B's unattestable-marker path, (b) any descriptor-pinned
// walk in the byte reader, (c) H17's GIT-STATUS arm, which alone sees the
// ' D hooks/sub/gate.mjs' this swap necessarily produces — and record which
// one actually carries the verdict. If (c) is the carrier, this pin does NOT
// bind the ancestor-classification fix at all and must be REPORTED AS HOLLOW
// rather than kept: it would then be exactly the "green for a reason nobody
// checked" failure that Finding C is about, wearing a repaired fixture.
//
// WHICH GUARD CARRIES THE VERDICT — a LIMIT, not a claim. Ruling B's
// unattestable-marker path and a descriptor-pinned walk would BOTH produce a
// deny here, so this pin may well be satisfied by defense in depth. That is
// not a defect, but it does mean a green here does not identify WHICH layer
// held. Determining that needs every candidate layer stripped in turn, which
// is the conductor's mutation run (23afbc83), not this author's to assert.
//
// #########################################################################
// ASSERTION REPAIR — 2026-08-26 (SECOND repair; supersedes the SABOTAGE and
// hollowness paragraphs above, which are left intact as the record of what
// was authored and of what the mutation run then MEASURED).
// #########################################################################
//
// THE PIN WAS PROVEN HOLLOW — measured, not inferred. The conductor's mutation
// run (23afbc83) was executed with the clean-room harness instrumented to log
// each hook invocation's stderr. It found exactly the failure the hollowness
// paragraph above told it to look for: item (c), H17's GIT-STATUS ARM, is a
// SECOND CARRIER of exit 2 for this fixture, and an exit-code-only assertion
// cannot tell the two carriers apart. 16/16 green UNDER THE SABOTAGE.
//
// THE TWO CARRIERS, recorded verbatim so the next reader does not have to
// re-derive them:
//   UNMUTATED — the layer this pin NAMES fires (the depth-0
//   `assertRealAncestors` call in `pathState`, the residual-TOCTOU fix this
//   pin exists to bind):
//     (A) state snapshot of 'hooks/sub/gate.mjs': ... its ancestor 'hooks/sub'
//     is not a directory (lstat kind: symlink)
//   UNDER THE SABOTAGE (remove `if (depth === 0) assertRealAncestors(...)`
//   from `pathState`) — STILL exit 2, via a DIFFERENT layer, H17's git-status
//   arm reacting to the `?? hooks/sub` the symlink swap necessarily produces:
//     H17: write(s) BY THIS COMMAND outside its contract, reverted: hooks/sub
//
// THE REPAIR, and WHY IT NOW DISCRIMINATES. The treatment arm now asserts on
// the DENIAL'S CONTENT as well as its exit code: the stderr must name the
// ANCESTOR CLASSIFICATION (the concept noun — `ancestor` / `path component` /
// `parent component`) AND must name the swapped ancestor path `hooks/sub`.
// The second alone is NOT a discriminator — both carriers name that path — so
// it is the FIRST that carries the verdict, and the pair is asserted together
// only so a stray mention of the concept somewhere unrelated cannot satisfy
// the pin. Compare the two traces above: the git-status arm's message speaks
// of a WRITE OUTSIDE A CONTRACT THAT WAS REVERTED and contains no ancestor-
// classification wording at all, so a denial arriving from that arm can no
// longer satisfy this pin. Under the named sabotage the exit code is still 2,
// the ancestor-classification assertion FIRES, and the pin goes RED — which is
// precisely what it failed to do before this repair.
//   DELIBERATELY NOT a full-string equality on the observed message: the
//   surrounding wording ("state snapshot of", "is not a directory (lstat kind:
//   symlink)") is the implementation's to phrase, and pinning it would turn
//   every harmless rewording into a false red. The concept noun plus the path
//   is the substantive discriminator; the alternation covers synonym
//   rewording, and every alternative in it is absent from the git-status arm's
//   message. If a future implementation denies for the right reason while
//   naming it with none of those words, this pin goes red LOUDLY and is
//   updated deliberately — which is the correct failure direction.
//
// SABOTAGE, AS IT NOW STANDS (this is the one-line change the repaired pin
// must go RED under, superseding the restatement above): remove the depth-0
// `assertRealAncestors` call from `pathState` (equivalently: start the
// ancestor walk at the leaf's parent-of-parent, or drop the ancestor
// components from what the classifier attests). Under that one line the
// TREATMENT must go RED — NOT on `post.code` any more, which stays 2 via the
// git-status arm, but on the ANCESTOR-CLASSIFICATION assertion, with the
// actual stderr being the second trace above. The CONTROL arm and every other
// pin in this file must stay GREEN: no other test here has a symlinked
// ancestor, so nothing else can move.
//
// HOLLOWNESS NOTE — read this before believing a green. A GREEN HERE IS ONLY
// EVIDENCE IF THE ANCESTOR-CLASSIFICATION WORDING IS WHAT PRODUCED IT. The
// git-status confound is unremovable by any fixture (the block above explains
// why), so exit 2 alone means nothing on this fixture, and it is the stderr
// assertion — not the exit code — that carries this pin's verdict. Anyone who
// weakens that assertion back to an exit-code-only check restores a pin that
// has ALREADY BEEN MEASURED GREEN UNDER ITS OWN SABOTAGE. If the treatment
// stays green under the sabotage even WITH the content assertion, that is not
// automatically defense in depth: strip each remaining candidate in turn —
// (a) Ruling B's unattestable-marker path, (b) any descriptor-pinned walk in
// the byte reader — and record which one actually carries the verdict.
// #########################################################################

function nestedGateRel() {
  return ['hooks', 'sub', 'gate.mjs'];
}

test(
  'PIN-SLICE1-SWAPPED-ANCESTOR-NOT-ATTESTED: CONTROL — a pre-dirty enforcement file in a NESTED real directory, untouched across the window, allows at Post',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      mkdirSync(join(dir, 'hooks', 'sub'), { recursive: true });
      writeFileSync(join(dir, ...nestedGateRel()), '// committed baseline\nprocess.exit(0);\n');
      git(dir, ['add', '-A'], { must: true });
      git(dir, ['commit', '-q', '-m', 'add nested enforcement hook'], { must: true });

      const dirtyBytes = '// conductor rebuild, not yet committed\nprocess.exit(0);\n';
      writeFileSync(join(dir, ...nestedGateRel()), dirtyBytes);

      const L = lane('ancestor-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of a pre-dirty NESTED enforcement file succeeds');

      assert.equal(readFileSync(join(dir, ...nestedGateRel()), 'utf8'), dirtyBytes, 'PRECONDITION: nothing touches the file across the window');
      assert.equal(lstatSync(join(dir, 'hooks', 'sub')).isDirectory(), true, 'PRECONDITION: and its ancestor is a REAL directory the whole time — the only difference from the treatment arm');

      const post = h17(dir, 'PostToolUse', L);
      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        0,
        `CONTROL: an unchanged pre-dirty file in a nested directory must allow. This arm passes for the OPPOSITE reason to the treatment arm and is what makes that arm's denial attributable to the ANCESTOR SWAP rather than to nesting, to the extra commit, or to the path shape — actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE1-SWAPPED-ANCESTOR-NOT-ATTESTED: an enforcement path whose ANCESTOR is swapped for a symlink to an out-of-repo decoy with byte-identical content must NOT be attested unchanged — it must DENY',
  { skip: GIT_SKIP || DIR_SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const decoyDir = mkdtempSync(join(tmpdir(), 'sterling-h17-decoy-ancestor-'));
    try {
      mkdirSync(join(dir, 'hooks', 'sub'), { recursive: true });
      writeFileSync(join(dir, ...nestedGateRel()), '// committed baseline\nprocess.exit(0);\n');
      git(dir, ['add', '-A'], { must: true });
      git(dir, ['commit', '-q', '-m', 'add nested enforcement hook'], { must: true });

      const dirtyBytes = '// conductor rebuild, not yet committed\nprocess.exit(0);\n';
      writeFileSync(join(dir, ...nestedGateRel()), dirtyBytes);

      // FIXTURE ISOLATION (repaired — see the block above for why whole-tree
      // porcelain equality was unsatisfiable by construction). Porcelain lines
      // are partitioned by the fixture subtree; ONLY the outside partition is
      // invariant across the swap, so only that is asserted.
      const FIXTURE_SUBTREE = 'hooks/sub';
      const porcelainOutsideFixture = () =>
        git(dir, ['status', '--porcelain'])
          .stdout.split('\n')
          .filter(Boolean)
          .map((l) => l.replace(/\s+$/, ''))
          .filter((l) => {
            // porcelain v1 line = "XY <path>"; a rename carries "old -> new".
            // A line counts as INSIDE only if EVERY path it names is inside,
            // so an entry straddling the boundary — or any line this parser
            // does not understand — lands OUTSIDE and makes the guard fire
            // rather than hide.
            const paths = l
              .slice(3)
              .split(' -> ')
              .map((p) => p.replace(/^"(.*)"$/, '$1'));
            return !paths.every((p) => p === FIXTURE_SUBTREE || p.startsWith(FIXTURE_SUBTREE + '/'));
          })
          .sort();

      const outsideBefore = porcelainOutsideFixture();

      const L = lane('ancestor-treatment');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre classifies and snapshots the pre-dirty nested enforcement file while its ancestor is a REAL directory');

      // THE SWAP — inside the window, the ANCESTOR directory (not the leaf)
      // is replaced by a symlink pointing out of the repo. The decoy presents
      // a file of the same name with byte-identical content, so nothing that
      // resolves the path and hashes the result can tell that the object it
      // is reading is no longer the object that was classified.
      writeFileSync(join(decoyDir, 'gate.mjs'), dirtyBytes);
      assert.equal(
        realpathSync(decoyDir).startsWith(realpathSync(dir)),
        false,
        'FIXTURE ISOLATION: the decoy must genuinely live OUTSIDE the fixture repo. A decoy created inside it would leave the swapped content visible to git and reachable without leaving the repo, silently destroying the very thing this pin discriminates'
      );
      rmSync(join(dir, 'hooks', 'sub'), { recursive: true, force: true });
      symlinkSync(decoyDir, join(dir, 'hooks', 'sub'), 'dir');

      assert.equal(lstatSync(join(dir, 'hooks', 'sub')).isSymbolicLink(), true, 'PRECONDITION: the ancestor is now a symlink pointing out of the repo');
      assert.equal(lstatSync(join(dir, ...nestedGateRel())).isSymbolicLink(), false, 'PRECONDITION: the LEAF is still an ordinary regular file — a leaf-only type check has nothing to object to, which is what makes this fixture discriminate a naive `if (type === symlink) deny` from a real resolution-aware guard');
      assert.equal(readFileSync(join(dir, ...nestedGateRel()), 'utf8'), dirtyBytes, 'PRECONDITION: and it presents byte-identical content through the swapped ancestor, so a hash-by-path comparison sees no change at all');

      const outsideAfter = porcelainOutsideFixture();
      assert.deepEqual(
        outsideAfter,
        outsideBefore,
        `FIXTURE ISOLATION (not a defect verdict): the swap must be CONFINED to ${FIXTURE_SUBTREE}. Every git-visible entry OUTSIDE the fixture subtree must be identical before and after, so that a denial below can never be caused by the fixture leaking into the rest of the repo (a clobbered hooks/hooks.json, a stray write under src/, a decoy landing inside the repo). What this does NOT claim: INSIDE the subtree git legitimately reports the directory-to-symlink swap (a ' D' for the tracked leaf git can no longer descend to, plus a '??' for the link itself) — that delta is the swap's own definition, is unremovable by any fixture, and is DISCLOSED in the block above rather than asserted away. If THIS fires, the fixture has stopped being confined and must be repaired before any verdict from this pin is believed — outside before: ${JSON.stringify(outsideBefore)}, outside after: ${JSON.stringify(outsideAfter)}`
      );

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        2,
        `An attested state must belong to the object that was CLASSIFIED. Here the enforcement path's ancestor was replaced by a symlink out of the repo between the checkpoints: the bytes match, the leaf type matches, and a guard that lstats by path and then hashes the same path reports "unchanged" about a file it has never read — the real hooks/sub was swapped out from under the gate. Ruling B's "never read through a symlink" covers an ancestor exactly as it covers a leaf. Actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );

      // THE DISCRIMINATOR — see "ASSERTION REPAIR" in the block above. Exit 2
      // alone was MEASURED to be satisfiable by a SECOND carrier (H17's
      // git-status arm reacting to the `?? hooks/sub` this swap necessarily
      // produces), so the exit-code assertion above cannot carry this pin's
      // verdict. The denial must NAME the ancestor classification.
      const postErr = oneLine(post.stderr);
      assert.match(
        postErr,
        /\b(?:ancestor|path component|parent component)\b/i,
        `THE PIN'S LOAD-BEARING ASSERTION. This pin binds the ANCESTOR-CLASSIFICATION layer (the depth-0 assertRealAncestors call in pathState), and exit 2 does NOT identify it: the git-status arm denies this same fixture with "H17: write(s) BY THIS COMMAND outside its contract, reverted: hooks/sub", which is exit 2 with no ancestor reasoning anywhere behind it — measured, with the ancestor fix removed, 16/16 green. The denial must therefore state that the path's ANCESTOR was classified and refused, in the shape of "(A) state snapshot of 'hooks/sub/gate.mjs': ... its ancestor 'hooks/sub' is not a directory (lstat kind: symlink)". Exact wording is the implementation's to choose; the ancestor-classification concept is not. If THIS fires while the exit code above is still 2, the denial came from the OTHER carrier and the ancestor guard is not doing the work — actual stderr: ${postErr}`
      );
      assert.match(
        postErr,
        /hooks[/\\]sub/,
        `and the ancestor-classification denial must name THIS fixture's swapped ancestor, hooks/sub — on its own this is not a discriminator (both carriers name the path), it is here only so that a mention of the ancestor-classification concept about some unrelated path cannot satisfy the assertion above — actual stderr: ${postErr}`
      );
      assert.equal(
        readFileSync(join(decoyDir, 'gate.mjs'), 'utf8'),
        dirtyBytes,
        'and nothing was written THROUGH the symlinked ancestor to the out-of-repo decoy — a denial on pre-existing dirt is never reverted (decision f76d7c5c), and a restore that followed the swapped ancestor would be the guard itself writing outside the repo'
      );
    } finally {
      cleanup([decoyDir]);
    }
  }
);

// #########################################################################
// NOT PINNED — deliberate gaps, recorded here so the next reader can see
// them instead of inferring coverage from the file's length
// #########################################################################
//
// (1) FINDING B's INTRA-CALL RACE. Covered above only in its Pre-to-Post
//     instantiation; see that pin's COVERED / NOT COVERED block. Making the
//     genuine intra-call window deterministic needs an interposition seam in
//     the hook (something on the order of a test-only wait between classify
//     and read). This file has precedent for SPECIFYING a required seam
//     rather than faking a condition — the PROCFS_FD_DIR seam at the top was
//     specified exactly that way — but a PAUSE seam inside a security gate is
//     a materially larger ask than a path override, and it is a design
//     decision for the conductor and the user, not something a test author
//     should mint by writing a test that assumes it. Until then the residual
//     is real and unpinned.
//
// (2) FINDING D — the marker-shape validator accepting any non-empty string
//     instead of the literal marker. NOT PINNED, and I could not find an
//     honest way to pin it from outside the process. The validator is only
//     reachable through a state record the hook writes and reads itself, so
//     the only boundary-level route is to tamper with that record between Pre
//     and Post and assert Post denies. That test would be worthless for THIS
//     claim: the campaign hardens the record's own integrity checking, so a
//     tampered record would deny because it was TAMPERED, not because the
//     marker was invalid — the pin would go green while the validator stayed
//     as weak as the finding says it is. That is precisely the hollow-pin
//     failure Finding C is about, so writing it would be worse than leaving
//     the gap visible. The two honest routes both need a decision this author
//     cannot take: export the validator so a test can call it directly with
//     the literal marker, a different non-empty string, and an empty string;
//     or drive it through a fixture where a non-literal marker can arise
//     observably. Same for the related claim that the generic guard is not
//     universal because an earlier absent-state return precedes it — its
//     reachability is a source-level fact, and the finding itself says there
//     is no reachable allow path today, so there is no behavior at the
//     boundary to pin.
// #########################################################################
