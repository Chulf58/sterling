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
