// H17 SECURE-I/O REDESIGN — SLICE 2 (decision 532a4383
// h17-baseline-integrity-redesign-rulings-abcd, build plan; residuals named in
// decision dfe70090 h17-slice1-accepted-with-named-residuals and boarded as
// f3ad629d). Slice 2 lands the DESCRIPTOR-PINNED WRITE/DELETE/READ PRIMITIVES
// and closes residuals 1 and 3.
//
// WHAT THIS FILE PINS, AND WHY IT IS SHORT. Residual 3 (the intra-call
// classify->read window) is closed by holding descriptors across the operation.
// That is, at the process boundary, a BEHAVIOR-PRESERVING change: it alters what
// happens during a RACE, and a race has no deterministic observable from outside
// the hook. The 119 existing h17 tests are its regression net and they stay
// green. Residual 1 — the procfs probe — is different: it has a fully STATIC
// adversarial fixture, and it is what this file pins.
//
//   PIN-SLICE2-PROCFS-DECOY-HARD-DENY — residual 1. The Slice 1 probe pinned a
//     directory descriptor and required <ANCHOR>/<fd> to lstat as a symlink and
//     stat-resolve to the same dev+ino as that descriptor's own fstat. That
//     proves ONE numeric entry resolves correctly. It does NOT prove the anchor
//     dynamically maps ARBITRARY fd numbers, and no finite set of numeric-entry
//     probes ever can, because a decoy can emulate every number the probe
//     happens to sample. A directory pre-seeded with numeric symlinks over a
//     plausible fd range, all pointing at the repo root, therefore PASSES the
//     Slice 1 probe — and then, when the walk opens a CHILD fd, every anchored
//     <decoy>/<childFd>/<name> resolves to the wrong object or to nothing, every
//     component classifies 'absent', 'absent' is explicitly not a violation, and
//     the whole mechanism DEGRADES TO ALLOW. That is precisely the silent
//     auto-degrade Ruling C rejected by name.
//
// THE FIX SHAPE THIS PIN IS AGNOSTIC ABOUT, and the one property it demands.
// This pin does not say HOW availability must be established. It demands only
// that the verdict CANNOT be satisfied by a decoy that reproduces the Slice 1
// round-trip — i.e. that availability rests on something an unprivileged
// attacker-controlled directory cannot forge. (The implementation chose the
// kernel filesystem magic via statfs; any equivalent would satisfy this file.)
//
// HARNESS is a faithful copy of h17-secure-io-slice1.test.mjs's idiom
// (makeGitProject, the Pre/Post pair sharing one tool_use_id per lane, oneLine,
// GIT_SKIP/PROCFS_* probes) — NOT imported, since that file exports nothing.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-secure-io-slice2.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  lstatSync,
  statSync,
  fstatSync,
  openSync,
  closeSync,
  existsSync,
  constants as FS,
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

// Ruling C names the Linux /proc/self/fd preflight specifically; native Windows
// runs the wholly different detect-and-abort arm (2a69a8d7), so this file's
// pins are meaningless there and skip loudly rather than fake a verdict.
const PROCFS_WIN32_SKIP = process.platform === 'win32' ? 'procfs is Linux-only — native Windows uses the lstat/fstat detect-and-abort arm per decision 2a69a8d7, not a /proc/self/fd preflight' : false;

const PROCFS_HOST_SKIP = (() => {
  try {
    return existsSync('/proc/self/fd') ? false : 'this host has no /proc/self/fd — the CONTROL arm (a WORKING procfs anchor still allows) cannot be established, so the treatment arm would not be attributable';
  } catch (e) {
    return `/proc/self/fd is not probeable on this host (${e.code ?? e.message})`;
  }
})();

// A SECOND, genuinely different working procfs fd directory. It is the control
// that separates "the fix authenticates procfs" from "the fix hardcoded
// /proc/self/fd" — the same role it plays in the Slice 1 file.
const PROCFS_ALIAS = '/proc/thread-self/fd';
const PROCFS_ALIAS_SKIP = (() => {
  try {
    return existsSync(PROCFS_ALIAS) ? false : `${PROCFS_ALIAS} is not present on this host — the anti-hardcode control needs a SECOND working procfs fd directory and will not fake one`;
  } catch (e) {
    return `${PROCFS_ALIAS} is not probeable on this host (${e.code ?? e.message})`;
  }
})();

const DIR_SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-h17-s2-dirsymprobe-'));
    mkdirSync(join(d, 'real'), { recursive: true });
    symlinkSync(join(d, 'real'), join(d, 'link'), 'dir');
    const ok = lstatSync(join(d, 'link')).isSymbolicLink() && existsSync(join(d, 'link', '.'));
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'directory symlinks are not observable on this host — the decoy anchor cannot be built';
  } catch (e) {
    return `directory symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-secio2-'));
  const runId = 'r-h17si2-' + randomUUID().slice(0, 8);

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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; the fixture does no mutating
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

// THE DECOY. A directory that is NOT procfs, pre-seeded with numeric symlinks
// over a plausible fd range, every one of them pointing at `target` (the repo
// root — the very object the probe pins). FD_RANGE is deliberately generous:
// the point of the fixture is that an attacker does not have to guess the
// probe's fd number, only to cover the range, and a hook process opens low
// descriptors.
const FD_RANGE = 256;
function makeSeededDecoy(target) {
  const decoy = mkdtempSync(join(tmpdir(), 'sterling-h17-s2-decoy-procfs-'));
  for (let i = 0; i <= FD_RANGE; i++) symlinkSync(target, join(decoy, String(i)), 'dir');
  return decoy;
}

// The Slice 1 probe, reproduced IN THIS TEST PROCESS. It is not here to check
// the hook; it is the PRECONDITION that makes the treatment arm attributable.
// If this returns 'AVAILABLE' against the decoy, then every check Slice 1
// performed is satisfied by the decoy, and any denial the hook produces must
// come from something STRICTLY BEYOND that round-trip. That is a
// wording-independent discriminator, which is what this pin's verdict rests on.
function slice1RoundTrip(anchor, probeDir) {
  let fd = null;
  try {
    fd = openSync(probeDir, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK);
    const anchored = `${anchor}/${fd}`;
    const entry = lstatSync(anchored);
    const through = statSync(anchored);
    const direct = fstatSync(fd);
    if (!entry.isSymbolicLink()) return 'DENIED: the anchor entry is not a symlink';
    if (String(through.dev) !== String(direct.dev) || String(through.ino) !== String(direct.ino)) return 'DENIED: dev/ino mismatch';
    return 'AVAILABLE';
  } catch (e) {
    return `DENIED: threw ${e.code ?? e.message}`;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// #########################################################################
// PIN-SLICE2-PROCFS-DECOY-HARD-DENY — residual 1 (HIGH)
// #########################################################################
//
// CONTROL ARMS FIRST, AND THEY MUST PASS FOR THE OPPOSITE REASON. "Pre denied"
// has more than one possible cause: a genuinely rejected anchor, a seam the
// code refuses on principle, or a fixture that denies everything. Two controls
// remove both alternatives — the REAL /proc/self/fd must ALLOW (the seam is
// consulted and is not a poison pill, and this fixture does not deny by
// itself), and /proc/thread-self/fd must ALSO allow (the fix authenticates
// procfs rather than string-comparing one blessed path, so a hardcode is
// visible as a failure here rather than as a silent narrowing).
//
// SABOTAGE — the one-line change that must flip the treatment RED, MEASURED
// against the Slice 1 code: delete the filesystem-authentication step and keep
// only the descriptor round-trip. Measured 2026-08-26 on the pre-fix source:
// with that step disabled, ALL 16 Slice 1 pins stayed GREEN, including the
// PRESENT-BUT-WRONG pin — so no existing pin carries this verdict, and this one
// is not a restatement of any of them. WHICH GUARD CARRIES THE VERDICT: the
// filesystem-authentication step, alone. There is no second layer here, by
// construction — the decoy is built to satisfy every other layer.
//
// A SECOND, SUBTLER SABOTAGE that must also flip it red: keep the
// authentication but downgrade its verdict from a hard deny to a warning or a
// fall-through — the auto-degrade 532a4383 rejected by name.
// #########################################################################

test(
  'PIN-SLICE2-PROCFS-DECOY-HARD-DENY: CONTROL — with the anchor pointing at the REAL /proc/self/fd, Pre allows an ordinary read-only Bash lane',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const L = lane('s2-decoy-control-real');
      const control = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: '/proc/self/fd' });
      assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        control.code,
        0,
        `CONTROL: a genuine procfs fd directory must still ALLOW. This arm must pass for the OPPOSITE reason to the treatment below — it is what makes that denial legible as being about the DECOY rather than "the seam is a poison pill" or "this fixture denies everything" — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE2-PROCFS-DECOY-HARD-DENY: CONTROL — a DIFFERENT genuine procfs fd directory (/proc/thread-self/fd) must also ALLOW, so the fix authenticates procfs rather than hardcoding one path',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP || PROCFS_ALIAS_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const L = lane('s2-decoy-control-alias');
      const control = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: PROCFS_ALIAS });
      assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        control.code,
        0,
        `CONTROL: ${PROCFS_ALIAS} is a real, working procfs fd directory that is NOT the literal '/proc/self/fd'. Rejecting it would mean the anchor is being string-compared (or the filesystem check is wrong about procfs), and the hardening below would have been bought by narrowing the mechanism rather than by authenticating it — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-SLICE2-PROCFS-DECOY-HARD-DENY: a decoy directory pre-seeded with numeric symlinks over a plausible fd range SATISFIES the Slice 1 round-trip and must still HARD-DENY — an anchor is available only if it is genuinely procfs, never because it reproduced the probe',
  { skip: GIT_SKIP || PROCFS_WIN32_SKIP || PROCFS_HOST_SKIP || DIR_SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const decoy = makeSeededDecoy(dir);
    try {
      // PRECONDITION 1 — the decoy is a plain directory, not procfs.
      assert.equal(existsSync(decoy), true, 'PRECONDITION: the decoy EXISTS, so a presence-only probe would accept it as available');
      assert.ok(readdirSync(decoy).length > FD_RANGE, 'PRECONDITION: and it is POPULATED across the fd range, so a non-empty-listing probe would accept it too');

      // PRECONDITION 2 — THE LOAD-BEARING ONE. Every check Slice 1 performed is
      // satisfied by this decoy. Whatever denies below is therefore strictly
      // beyond that round-trip, and this pin's verdict does not depend on the
      // wording of any message.
      assert.equal(
        slice1RoundTrip(decoy, dir),
        'AVAILABLE',
        'PRECONDITION: the decoy must SATISFY the Slice 1 probe — its numeric entries lstat as symlinks and stat-resolve to exactly the object the pinned descriptor holds. If this fails, the fixture is not adversarial enough and the treatment below proves nothing; fix the fixture, never the assertion.'
      );
      assert.equal(slice1RoundTrip('/proc/self/fd', dir), 'AVAILABLE', 'PRECONDITION: and the same round-trip passes against REAL procfs, so it is a faithful reproduction of Slice 1 and not a broken check that passes everything');

      const L = lane('s2-decoy-treatment');
      const res = h17(dir, 'PreToolUse', L, { STERLING_H17_PROCFS_FD_DIR: decoy });

      assert.notEqual(res.code, 1, 'a security gate never fails with a non-blocking exit 1 — an unusable prevention mechanism must be a loud deny, never a silent non-blocking warning');
      assert.equal(
        res.code,
        2,
        `Ruling C (decision 532a4383): an anchor is AVAILABLE only when it genuinely maps arbitrary descriptor numbers, and a decoy proves it does not by construction — its numeric entries were pre-seeded, so a CHILD fd opened later during the walk resolves to the wrong object or to nothing, every component classifies 'absent', nothing is judged a violation and the mechanism DEGRADES TO ALLOW. A finite round-trip cannot tell the two apart; only a property the decoy cannot forge can. Actual ${res.code}, stderr: ${oneLine(res.stderr)}`
      );
      assert.ok(
        oneLine(res.stderr).includes('secure I/O unavailable'),
        `the denial must state the reason Ruling C names — 'secure I/O unavailable' — so an operator can tell a security refusal from a contract violation. Actual stderr: ${oneLine(res.stderr)}`
      );
      // SECONDARY, wording-dependent and deliberately marked as such: the
      // denial should say the anchor is not the kernel's procfs, not merely
      // that some entry looked wrong — an operator who sees the latter will go
      // looking for a broken symlink instead of a substituted anchor. The
      // verdict above does not rest on this line.
      assert.match(
        oneLine(res.stderr),
        /procfs/i,
        `SECONDARY (diagnosis quality, not the verdict): the message should name the filesystem-authentication failure rather than an entry-level one, so the operator looks for a substituted anchor. Actual stderr: ${oneLine(res.stderr)}`
      );

      // And the denial must land BEFORE any enforcement-surface I/O: an unusable
      // anchor that has already written a baseline record has read the tree
      // through the very mechanism it just declared unusable.
      assert.equal(
        tempRecords(createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16)).length,
        0,
        'and the hard deny must precede the enforcement-surface I/O — no (B) baseline record may be left behind by a lane whose secure-I/O layer was never available'
      );
    } finally {
      cleanup([decoy]);
    }
  }
);

// #########################################################################
// NOT PINNED — deliberate gaps, recorded so the next reader can see them
// instead of inferring coverage from this file's length
// #########################################################################
//
// (1) RESIDUAL 3's INTRA-CALL WINDOW, the thing Slice 2 exists to close. The
//     parent descriptor is now held across classify->read/hash/write/delete, so
//     nothing re-resolves by pathname mid-operation. That changes the outcome of
//     a RACE and nothing else, and a race has no deterministic observable from
//     outside the hook process. Pinning it needs a test-only interposition seam
//     (an inert hook between "parent pinned" and "leaf operation") that the
//     Slice 1 file also recorded as unpinned for the same reason. The
//     implementer DECLINED to add that seam in Slice 2 and referred the call
//     upward: every shape considered (a blocking rendezvous, a spawned helper)
//     puts either a stall or an exec into the middle of a security gate, and a
//     stalled hook is timeout-killed into a non-2 exit, which the platform reads
//     as ALLOW — i.e. the seam's failure mode is the exact fail-open class this
//     redesign exists to remove. The regression evidence in its place: the 119
//     existing h17 tests stay green across the refactor, and the mutation battery
//     recorded above established which guard carries each existing verdict.
//
// (2) REPO-ROOT AUTHENTICATION (residual 2) is OUT OF THE THREAT MODEL, closed
//     by DISCLOSURE and not by mechanism (decision
//     h17-repo-root-authentication-is-out-of-scope). H17 assumes the workspace
//     root selected by the hook runner is the trusted namespace anchor. It
//     prevents or detects redirection below that root, but does not authenticate
//     root identity across hook processes: a per-process descriptor authenticates
//     only its own invocation, and persisting the root's dev/ino into the temp
//     records would authenticate nothing because those records are themselves
//     agent-writable. An actor able to rename or replace the workspace root, its
//     .git, or the parent namespace is OUTSIDE H17's protection boundary — and
//     can equally replace the store, the config and the enforcement surface, so
//     nothing is left for this hook to protect. There is deliberately NO pin
//     here: a test asserting a documented non-guarantee would either restate the
//     disclosure (worthless) or freeze a behavior nobody promised.
//
// (3) THE TYPE-CHECK-BEFORE-TRUNCATE ORDER in the (B) write primitive (fstat the
//     opened descriptor to prove it is a regular file BEFORE ftruncate; never
//     O_TRUNC on the open, which mutates before the type is known) is
//     DEFENSE-IN-DEPTH and NOT reachable from this boundary: the (B) baseline
//     collection classifies every surface path first and throws on any
//     non-regular entry, so the restore is never entered with a directory, fifo
//     or symlink at the leaf. Same disposition, and same reasoning, as the
//     backslash arm of validateBaselineKey, which the hook already documents as
//     "reasoning-verified, not interface-tested". Pinning it honestly needs the
//     primitive exported for a direct unit call, which is a decision for the
//     conductor and not something a test author should mint.
//
// (3b) THE RECURSIVE-DELETE WALK BUDGET has no carrier here either. The
//     untracked-restore delete now charges the shared walk budget per entry as
//     each entry arrives (so an enormous flat directory denies instead of
//     killing the process into a non-2 ALLOW), but no fixture drives a delete of
//     a tree large enough to trip it — the existing WIDE/DEEP budget pins in
//     h17-bounded-io.test.mjs exercise the (A) SNAPSHOT walk, not the delete
//     walk, and a snapshot-side denial fires first on the same fixture, so a
//     delete-side pin would be satisfied by the wrong carrier. Pinning it
//     honestly needs a fixture that reaches the restore path with an oversized
//     not-in-HEAD untracked directory; that is worth adding and is not added
//     here, because a pin whose carrier cannot be isolated is worse than a
//     recorded gap.
//
// (4) "THE ROOT ANCHOR IS OPENED ONCE PER INVOCATION" has NO external
//     observable: reopening it per classifier produces byte-identical behavior
//     at the process boundary. It is a structural property, verifiable by
//     reading the source, and asserting it from outside would require a probe
//     that counts opens — i.e. the same interposition seam gap (1) records.
// #########################################################################
