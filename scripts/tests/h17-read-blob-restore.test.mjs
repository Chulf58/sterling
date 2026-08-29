// H17 RULING A — LOCK-FREE READ-BLOB RESTORE (decision 532a4383
// h17-baseline-integrity-redesign-rulings-abcd, RULING A / build-plan slice
// S3; second, index-consequence arm from decision fd549420
// h17-attributes-legitimate-builds-by-pre-attested-publication-generation-not-quarantine).
//
// STATUS: NOT YET IMPLEMENTED. restoreTracked today shells out to
// `git checkout HEAD -- <rel>`. Ruling A replaces that with: resolve the
// HEAD blob OID + mode via NUL-safe `git ls-tree` (the `-z` shape), accept
// ONLY regular-file modes, stream `git cat-file blob <oid>`, and materialize
// through H17's existing descriptor-pinned write primitive. Two measured
// motivations: (1) descriptor safety — the path string was resolved
// externally by git; (2) `.git/index.lock` contention under conductor
// fan-out, which made `git checkout` fail and H17 fail closed with
// "ENVIRONMENT DEFECT (H17): ... Unable to create '.git/index.lock': File
// exists — failing closed (P5)".
//
// These tests are authored FROM THE TWO CITED DECISIONS ONLY, per H4 — no
// hook source was read. Most are expected RED NOW because the behavior is
// ABSENT, not because a fixture is broken; each test says which.
//
// HARNESS is a faithful copy of the makeGitProject/h17/lane/git/oneLine idiom
// shared by h17-secure-io-slice2.test.mjs, h17-stamp-honor.test.mjs and
// h17-percall-attribution.test.mjs (read for harness shape only) — NOT
// imported, since none of those files export anything.
//
// CRITICAL: this file never builds a bundle in place. Every test here drives
// scripts/hooks/h17-bash-write-sweep.mjs directly from its checked-out
// source location (the same HOOKS constant every precedent file uses) —
// exactly like the three precedent files — so no `build-hooks.mjs` call
// with an in-place `--out-dir` is needed or made.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-read-blob-restore.test.mjs

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
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
  lstatSync,
  linkSync,
  statSync,
  chmodSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
  constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
// T11's "outside the repo" victim file is a tmpdir() SIBLING of the ephemeral
// git project, NOT a sibling of this checkout.
//
// THE REPO THAT MATTERS IS THE FIXTURE, NOT THE CHECKOUT. Every test here
// builds its git project under `mkdtempSync(join(tmpdir(), ...))`, so "outside
// the repo under test" means outside THAT directory — and a tmpdir() sibling
// is both genuinely outside it and same-device by construction.
//
// Measured 2026-08-29, and the reason this comment exists: an earlier revision
// placed the victim under `dirname(root)` — one level above the real checkout —
// reasoning that a same-mount victim was the precondition. On this host that is
// exactly backwards: the checkout sits on /mnt/c (drvfs) while tmpdir() is
// /tmp (ext4), so pairing them guaranteed EXDEV, `link()` failed before the
// hook was ever exercised, and the module-scope probe aborted the WHOLE FILE —
// all ten ACs with it. Same-device is indeed the precondition; the mistake was
// picking the wrong repo to be outside of.
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// anti-pattern ee89c3fd: raw multi-line child-process stderr in an assertion
// message poisons the TAP crash/assertion classifier. Flatten, never truncate.
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

const SYMLINK_TRACK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-symprobe-'));
    writeFileSync(join(d, 'target.txt'), 'x');
    symlinkSync('target.txt', join(d, 'link.txt'));
    const ok = lstatSync(join(d, 'link.txt')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host — a tracked symlink HEAD entry cannot be constructed';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

const DIR_SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-dirsymprobe-'));
    mkdirSync(join(d, 'real'), { recursive: true });
    symlinkSync(join(d, 'real'), join(d, 'link'), 'dir');
    const ok = lstatSync(join(d, 'link')).isSymbolicLink() && existsSync(join(d, 'link', '.'));
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'directory symlinks are not observable on this host — the ancestor-symlink fixture cannot be built';
  } catch (e) {
    return `directory symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

const NL_FILENAME_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-nlprobe-'));
    const p = join(d, 'odd\nname.txt');
    writeFileSync(p, 'x');
    const ok = existsSync(p);
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'filenames containing a newline are not supported on this host filesystem';
  } catch (e) {
    return `filenames containing a newline are not supported on this host (${e.code ?? e.message})`;
  }
})();

// Loud, explicit capability probe — mirrors T11's EXACT cross-directory
// shape: an "outside" sibling under tmpdir() linked into a path shaped like
// the ephemeral git-project temp dir every test in this file uses (also under
// tmpdir()), so both sides are same-device by construction. Two DISTINCT
// failure modes must never be conflated:
//   - EXDEV (cross-device link): the fixture's OWN precondition is broken —
//     the two probed directories are on different devices. Since both are now
//     tmpdir() siblings this should be unreachable; if it ever fires, the
//     fixture has been edited to straddle a mount again. It is never a skip;
//     it throws and aborts the file loudly, because a silent skip here would
//     look identical to "hard links unsupported" while actually meaning "the
//     fixture never tested anything".
//   - any other failure (ENOSYS/EPERM/etc.): a genuine "this filesystem does
//     not support hard links" result, which DOES skip — naming both probed
//     directories so the skip reason is checkable, not just asserted.
const HARDLINK_SKIP = (() => {
  let outsideProbe;
  let targetProbe;
  try {
    outsideProbe = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-hlprobe-outside-'));
    targetProbe = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-hlprobe-target-'));
    const a = join(outsideProbe, 'a.txt');
    const b = join(targetProbe, 'b.txt');
    writeFileSync(a, 'x');
    try {
      linkSync(a, b);
    } catch (e) {
      if (e.code === 'EXDEV') {
        throw new Error(
          `BROKEN FIXTURE (not a skip): the outside-victim dir (${outsideProbe}) and the ephemeral git-project temp shape (${targetProbe}) are on DIFFERENT devices — link() failed EXDEV. Both are meant to be tmpdir() siblings, so this means the fixture has been edited to straddle a mount. T11's premise is a same-device victim OUTSIDE THE EPHEMERAL GIT PROJECT (not outside this checkout); fix the directory placement rather than letting this skip silently.`
        );
      }
      throw e;
    }
    const ok = statSync(b).nlink >= 2 && statSync(a).ino === statSync(b).ino;
    return ok
      ? false
      : `hard links are not supported between ${outsideProbe} and ${targetProbe} on this host/filesystem — the hardlink fixture cannot be constructed`;
  } catch (e) {
    if (typeof e.message === 'string' && e.message.startsWith('BROKEN FIXTURE')) throw e; // never swallow — must fail loudly, never skip
    return `hard links are not supported on this host (${e.code ?? e.message})`;
  } finally {
    if (outsideProbe) rmSync(outsideProbe, { recursive: true, force: true });
    if (targetProbe) rmSync(targetProbe, { recursive: true, force: true });
  }
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-'));
  const runId = 'r-h17rb-' + randomUUID().slice(0, 8);

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

function h17(dir, event, over = {}) {
  return runHook(
    'h17-bash-write-sweep.mjs',
    {
      session_id: 's1',
      transcript_path: join(dir, 'transcripts', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; the fixtures do the tampering
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

function bundlePath(dir) {
  return join(dir, 'hooks', 'h3-contract-gate.mjs');
}

function probeEolConversion(dir, relPath, rawBytes) {
  writeFileSync(join(dir, relPath), Buffer.from('scratch-corruption'));
  git(dir, ['checkout', '--', relPath], { must: true });
  const checkedOut = readFileSync(join(dir, relPath));
  writeFileSync(join(dir, relPath), rawBytes); // restore to the RAW form for the real test that follows
  return checkedOut.includes(0x0d) && !checkedOut.equals(rawBytes);
}

// =========================================================================
// AC1 — LOCK-FREE RESTORE (baseline functional pin)
//
// SABOTAGE: skip/no-op the materialization step so restoreTracked reports
// success without writing the resolved blob bytes into the file (or writes
// nothing at all). Target: the write-through call in restoreTracked's
// in-HEAD arm, scripts/hooks/h17-bash-write-sweep.mjs (Ruling A's new
// `cat-file blob` -> secureWriteUnder call site, replacing the `git checkout
// HEAD -- <rel>` call decision fd549420 cites at :2853). The bytes-equal-HEAD
// assertion goes red immediately. Cannot be applied/proven-landed yet — the
// implementation does not exist,
// so this test is RED NOW for the correct reason (absence), not a harness
// defect.
// =========================================================================

test('AC1: a Bash command dirties a tracked enforcement-surface path; H17 Post restores it and the bytes equal the HEAD blob bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const P = bundlePath(dir);
    const head = readFileSync(P, 'utf8');
    const L = lane('ac1-lock-free-restore');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');
    writeFileSync(P, '// audited command wrote this — must not survive\n');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC1: a genuinely new dirty tracked path restores+denies — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(P, 'utf8'), head, `AC1: after Post the file's bytes equal the HEAD blob's bytes — stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC2 — RESTORE SUCCEEDS UNDER INDEX-LOCK CONTENTION (the load-bearing
// regression pin for the measured incident quoted in decision 532a4383).
//
// The lock is constructed EXPLICITLY in the fixture (create the file, run,
// remove it in a finally) rather than relying on timing, per the brief.
//
// SABOTAGE: revert restoreTracked's in-HEAD arm to shell out to
// `git checkout HEAD -- <rel>` (the exact pre-Ruling-A call, target:
// scripts/hooks/h17-bash-write-sweep.mjs, the call site decision fd549420
// cites at :2853). Under a held `.git/index.lock`, that call fails, and the
// old behavior's fail-closed composition prints "ENVIRONMENT DEFECT (H17):
// ... Unable to create '.git/index.lock': File exists — failing closed (P5)"
// instead of restoring — flipping both the bytes-restored assertion and the
// "no ENVIRONMENT DEFECT phrase" assertion red. Cannot be applied yet — RED
// NOW for the correct reason (absence).
// =========================================================================

test('AC2: restore succeeds under held .git/index.lock contention and denies ordinarily — never the ENVIRONMENT DEFECT fail-closed path', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const lockPath = join(dir, '.git', 'index.lock');
  let lockHeld = false;
  try {
    const P = bundlePath(dir);
    const head = readFileSync(P, 'utf8');
    const L = lane('ac2-index-lock-contention');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');
    writeFileSync(P, '// audited command wrote this under contention\n');

    writeFileSync(lockPath, ''); // simulate another party holding the index lock
    lockHeld = true;
    assert.equal(existsSync(lockPath), true, 'PRECONDITION: the held lock file must actually exist before Post runs, or this test proves nothing about contention');

    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC2: the ordinary violation DENY must still fire under lock contention — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      readFileSync(P, 'utf8'),
      head,
      `AC2: THE LOAD-BEARING PROPERTY — the restore must succeed and materialize HEAD bytes even while .git/index.lock is held — stderr: ${oneLine(r.stderr)}`
    );
    assert.doesNotMatch(
      oneLine(r.stderr),
      /ENVIRONMENT DEFECT \(H17\)/i,
      `AC2: must NOT degrade into the "ENVIRONMENT DEFECT / failing closed" path that today's \`git checkout\` produces under index-lock contention — stderr: ${oneLine(r.stderr)}`
    );
    assert.doesNotMatch(
      oneLine(r.stderr),
      /Unable to create.*index\.lock/i,
      `AC2: must NOT surface the git-checkout index.lock failure text at all — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    if (lockHeld) rmSync(lockPath, { force: true });
    cleanup();
  }
});

// =========================================================================
// AC3 — NON-REGULAR HEAD MODE IS REFUSED (symlink HEAD entry replaced by a
// regular file). Asserts BOTH halves: refusal reported AND nothing
// materialized.
//
// SABOTAGE: drop the "accept only regular-file modes" gate so the
// materializer streams `cat-file blob <oid>` for ANY HEAD mode, including a
// symlink entry (whose blob content is the link target string). Target: the
// mode-check on the `git ls-tree` entry in the new restoreTracked
// materializer, scripts/hooks/h17-bash-write-sweep.mjs (net-new code per
// Ruling A — no line number exists yet). That writes new bytes into the
// tampered path — the bytes-unchanged assertion flips red. Cannot be applied
// yet — RED NOW for the correct reason (absence).
// =========================================================================

test('AC3: HEAD tree entry is a symlink (mode 120000); restore refuses loudly and materializes nothing', { skip: GIT_SKIP || SYMLINK_TRACK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const rel = 'tracked-link.txt';
    const p = join(dir, rel);
    symlinkSync('nonexistent-target.txt', p);
    git(dir, ['add', rel], { must: true });
    git(dir, ['commit', '-q', '-m', 'add tracked symlink'], { must: true });

    const L = lane('ac3-non-regular-mode');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    rmSync(p, { force: true }); // remove the symlink entry itself
    const tamperBytes = '// attacker replaced the symlink with a regular file\n';
    writeFileSync(p, tamperBytes); // ...with a plain regular file at the same path

    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC3: a non-regular HEAD mode must still deny the violation — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      readFileSync(p, 'utf8'),
      tamperBytes,
      `AC3: THE LOAD-BEARING PROPERTY — restore materializes NOTHING for a non-regular HEAD mode; the tampered bytes must be exactly what they were before Post ran — stderr: ${oneLine(r.stderr)}`
    );
    // SECONDARY, wording-dependent and deliberately marked as such: the
    // verdict above does not rest on this line.
    assert.match(
      oneLine(r.stderr),
      /non-regular|not a regular file|symlink|special file|unexpected mode|refus/i,
      `SECONDARY (diagnosis quality, not the verdict): the message should name the non-regular-mode refusal — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC4 — THE INDEX IS NOT SILENTLY "REPAIRED", AND IS NOT MISREPORTED.
// CONTROL runs FIRST and must pass for the OPPOSITE reason: an ordinary
// worktree-only-dirty path (index already matches HEAD, nothing was staged)
// is a genuinely full revert, so the deny message must NOT claim an index
// mismatch there. The TREATMENT stages a change into the index as well as
// the worktree, so after the lock-free worktree-only restore the index
// still differs from HEAD, and the message must name that disposition.
//
// SABOTAGE: compose the deny message with a hardcoded "restored to HEAD"
// (or equivalent) string that never queries/reports index state. Target: the
// deny-message composition for the clean-at-Pre/dirty-at-Post branch in
// scripts/hooks/h17-bash-write-sweep.mjs (net-new disclosure clause per
// decision fd549420's index-consequence arm — no line number exists yet).
// The TREATMENT's /index/i requirement goes red; the CONTROL stays green
// (it only forbids a mismatch claim, and the sabotage makes no claim at
// all) — demonstrating this pin is about the TREATMENT's disclosure
// specifically. Cannot be applied yet — RED NOW for the correct reason.
// =========================================================================

test('AC4 CONTROL: an ordinary worktree-only-dirty path (index already == HEAD) denies WITHOUT claiming an index mismatch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const P = bundlePath(dir);
    const L = lane('ac4-control-no-staging');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');
    writeFileSync(P, '// worktree-only tamper, never staged\n');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `CONTROL: a fresh worktree-only violation still denies — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.doesNotMatch(
      oneLine(r.stderr),
      /index.{0,20}(differ|mismatch|stale|out of sync|not match|inconsistent)/i,
      `CONTROL: the index genuinely matches HEAD here (nothing was \`git add\`ed) — the message must not claim an index mismatch that does not exist — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

test('AC4: a path staged into the INDEX (differing from HEAD) is worktree-restored but the DENY message names the outstanding index disposition', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const P = bundlePath(dir);
    const rel = 'hooks/h3-contract-gate.mjs';
    const head = readFileSync(P, 'utf8');
    const L = lane('ac4-treatment-staged');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    writeFileSync(P, '// staged AND worktree change — index will differ from HEAD\n');
    git(dir, ['add', rel], { must: true }); // stage into the index, not just the worktree

    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC4: an index-vs-HEAD mismatch survives a lock-free worktree restore, so the call must still DENY — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      readFileSync(P, 'utf8'),
      head,
      `AC4: the WORKTREE restore still happens (bytes equal HEAD) even though the index is not touched — stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      oneLine(r.stderr),
      /index/i,
      `AC4: THE LOAD-BEARING PROPERTY — a lock-free worktree write does not touch the git index, so the message must explicitly name the INDEX disposition rather than merely denying — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC5 — RAW BLOB BYTES, DELIBERATELY (disclosed caveat pinned as intended
// behavior). CONTROL runs FIRST and must pass for the OPPOSITE reason: it
// proves, using REAL `git checkout` and no H17 involvement at all, that
// eol=crlf conversion is actually active on this host/git config — so the
// TREATMENT's raw-bytes assertion is meaningfully about the hook choosing
// NOT to run the filter, not an artifact of a host where checkout would
// have produced the same bytes anyway. Both share EOL_CRLF_SKIP, a static
// probe computed once at module load in a throwaway repo.
//
// SABOTAGE: materialize via `git checkout HEAD -- <path>` (or apply the
// .gitattributes eol filter after reading the raw blob) instead of
// streaming raw `cat-file blob` bytes. Target: the restore-materialization
// call site in restoreTracked's in-HEAD arm (scripts/hooks/
// h17-bash-write-sweep.mjs — currently `git checkout HEAD -- <rel>` at the
// line decision fd549420 cites as :2853; Ruling A's replacement call site is
// the same location). The restored file would then contain CRLF, flipping
// both byte-equality assertions in the TREATMENT test red while the CONTROL
// stays green (it never calls the hook). Cannot be applied/verified yet —
// RED NOW for the correct reason (absence).
// =========================================================================

const EOL_CRLF_SKIP = (() => {
  if (GIT_SKIP) return GIT_SKIP;
  let probeDir;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-eolprobe-'));
    git(probeDir, ['init', '-q'], { must: true });
    git(probeDir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
    git(probeDir, ['config', 'user.name', 'H17 Test'], { must: true });
    git(probeDir, ['config', 'commit.gpgsign', 'false']);
    git(probeDir, ['config', 'core.autocrlf', 'false'], { must: true });
    const rawBytes = Buffer.from('line1\nline2\n', 'utf8');
    writeFileSync(join(probeDir, '.gitattributes'), 'raw.txt text eol=crlf\n');
    writeFileSync(join(probeDir, 'raw.txt'), rawBytes);
    git(probeDir, ['add', '-A'], { must: true });
    git(probeDir, ['commit', '-q', '-m', 'probe'], { must: true });
    const active = probeEolConversion(probeDir, 'raw.txt', rawBytes);
    return active ? false : 'this host/git config does not apply eol=crlf conversion on checkout — the precondition that a real checkout would alter bytes cannot be established here';
  } catch (e) {
    return `eol=crlf probe failed on this host (${e.code ?? e.message})`;
  } finally {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  }
})();

test('AC5 CONTROL: on this host, a REAL `git checkout` of a path with .gitattributes eol=crlf actually introduces CRLF bytes (no H17 involved)', { skip: EOL_CRLF_SKIP }, () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-eolcontrol-'));
  try {
    git(probeDir, ['init', '-q'], { must: true });
    git(probeDir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
    git(probeDir, ['config', 'user.name', 'H17 Test'], { must: true });
    git(probeDir, ['config', 'commit.gpgsign', 'false']);
    git(probeDir, ['config', 'core.autocrlf', 'false'], { must: true });
    const rawBytes = Buffer.from('line1\nline2\n', 'utf8');
    writeFileSync(join(probeDir, '.gitattributes'), 'raw.txt text eol=crlf\n');
    writeFileSync(join(probeDir, 'raw.txt'), rawBytes);
    git(probeDir, ['add', '-A'], { must: true });
    git(probeDir, ['commit', '-q', '-m', 'control'], { must: true });

    writeFileSync(join(probeDir, 'raw.txt'), Buffer.from('scratch-corruption'));
    git(probeDir, ['checkout', '--', 'raw.txt'], { must: true });
    const checkedOut = readFileSync(join(probeDir, 'raw.txt'));

    assert.ok(
      checkedOut.includes(0x0d),
      'CONTROL: a real `git checkout` on this host/git config must introduce a CR byte via eol=crlf, or the TREATMENT test below proves nothing about raw-vs-filtered bytes'
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('AC5: a path with a .gitattributes eol=crlf entry restores the RAW HEAD blob bytes, not what `git checkout` would produce', { skip: EOL_CRLF_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const rel = 'raw.txt';
    const rawBytes = Buffer.from('line1\nline2\n', 'utf8');
    writeFileSync(join(dir, '.gitattributes'), 'raw.txt text eol=crlf\n');
    writeFileSync(join(dir, rel), rawBytes);
    git(dir, ['add', '-A'], { must: true });
    git(dir, ['commit', '-q', '-m', 'add raw.txt + gitattributes'], { must: true });

    const L = lane('ac5-raw-blob-bytes');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    writeFileSync(join(dir, rel), Buffer.from('tampered\n'));
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC5: a genuinely new dirty tracked path restores+denies — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);

    const restored = readFileSync(join(dir, rel));
    assert.ok(
      restored.equals(rawBytes),
      `AC5: THE LOAD-BEARING PROPERTY — restored bytes must be the RAW HEAD blob bytes, not what \`git checkout\` under eol=crlf would produce — expected ${JSON.stringify(rawBytes.toString())}, actual ${JSON.stringify(restored.toString())}`
    );
    assert.ok(!restored.includes(0x0d), 'AC5: raw blob bytes must not contain the CR byte a real checkout under eol=crlf would introduce');
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC6a — NUL-SAFE PATH RESOLUTION (`git ls-tree -z`-shaped). A tracked path
// containing a newline byte, alongside a normal sibling entry as a control
// against cross-entry corruption from a newline-delimited misparse.
//
// SABOTAGE: invoke `git ls-tree` without `-z` and parse its output split on
// '\n' instead of NUL. Target: the `git ls-tree` invocation + parser in the
// new restoreTracked blob-resolution step, scripts/hooks/
// h17-bash-write-sweep.mjs (net-new per Ruling A — no line number exists
// yet). The embedded newline in the weird path's own name breaks record
// boundaries, misattributing OIDs — the weird path (and potentially its
// sibling) would restore wrong bytes or fail. Cannot be applied yet — RED
// NOW for the correct reason (absence).
// =========================================================================

test('AC6a: a tracked path containing a newline byte restores correctly via NUL-safe resolution, without corrupting a neighboring entry', { skip: GIT_SKIP || NL_FILENAME_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const weirdRel = 'odd\nname.txt';
    const siblingRel = 'normal-sibling.txt';
    const weirdC0 = 'weird-head-bytes\n';
    const siblingC0 = 'sibling-head-bytes\n';

    writeFileSync(join(dir, weirdRel), weirdC0);
    writeFileSync(join(dir, siblingRel), siblingC0);
    git(dir, ['add', '-A'], { must: true });
    git(dir, ['commit', '-q', '-m', 'add weird + sibling paths'], { must: true });

    const L = lane('ac6a-nul-safe');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    writeFileSync(join(dir, weirdRel), 'TAMPERED-WEIRD\n');
    writeFileSync(join(dir, siblingRel), 'TAMPERED-SIBLING\n');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC6a: two genuinely new dirty tracked paths restore+deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);

    assert.equal(
      readFileSync(join(dir, weirdRel), 'utf8'),
      weirdC0,
      `AC6a: THE LOAD-BEARING PROPERTY — the newline-named path resolves via NUL-safe ls-tree and restores its OWN HEAD bytes — stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(
      readFileSync(join(dir, siblingRel), 'utf8'),
      siblingC0,
      `AC6a CONTROL: the adjacent sibling entry restores correctly too — a newline-unsafe parse would misattribute OIDs across the record boundary and corrupt this one as a side effect — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC6b — NO SYMLINKED ANCESTOR. An ancestor directory of a tracked leaf is
// replaced by a symlink to an attacker-controlled location; materialization
// must never write through it. CONTROL runs FIRST and must pass for the
// OPPOSITE reason: it proves, with plain Node fs calls and NO H17
// involvement, that writing through this exact ancestor-symlink shape DOES
// land inside the attacker's directory on this host — so the TREATMENT's
// "nothing appeared there" is evidence of a real defense, not an artifact
// of an unreachable fixture (e.g. the whole call erroring out before ever
// attempting a write, for a reason unrelated to ancestor-symlink handling).
//
// SABOTAGE: materialize via plain `fs.writeFileSync(resolvedPath, bytes)`
// without verifying every ancestor path component is not a symlink. Node's
// fs write follows the symlinked ancestor transparently, creating leaf.txt
// inside the attacker's directory — the TREATMENT's non-materialization
// assertion flips red; the CONTROL is unaffected (it never calls the hook).
// Target: the ancestor-walk in H17's descriptor-pinned write primitive
// (secureWriteUnder / the write side of the shared secure-I/O layer landed
// in Ruling A/B slices S1-S2, scripts/hooks/h17-bash-write-sweep.mjs) as
// used by the new read-blob materializer. Cannot be applied/verified yet —
// RED NOW for the correct reason (absence).
// =========================================================================

test('AC6b CONTROL: on this host, writing through this exact symlinked-ancestor shape DOES land in the attacker directory (no H17 involved)', { skip: DIR_SYMLINK_SKIP }, () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-ancestor-control-'));
  const evilTarget = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-evil-control-'));
  try {
    symlinkSync(evilTarget, join(probeDir, 'sub'), 'dir');

    writeFileSync(join(probeDir, 'sub', 'leaf.txt'), 'plain-fs-write-through-ancestor-symlink\n');

    assert.equal(
      existsSync(join(evilTarget, 'leaf.txt')),
      true,
      'CONTROL: a plain fs write through this ancestor-symlink shape must land in the attacker directory on this host, or the TREATMENT test below proves nothing about the hook defending against it'
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(evilTarget, { recursive: true, force: true });
  }
});

test('AC6b: materialization never writes through a symlinked ancestor component', { skip: GIT_SKIP || DIR_SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const evilTarget = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-evil-'));
  try {
    const leafRel = 'sub/leaf.txt';
    const leafC0 = 'leaf-head-bytes\n';
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, leafRel), leafC0);
    git(dir, ['add', '-A'], { must: true });
    git(dir, ['commit', '-q', '-m', 'add sub/leaf.txt'], { must: true });

    const L = lane('ac6b-ancestor-symlink');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    // audited command replaces the ANCESTOR directory `sub` with a symlink
    // to an attacker-controlled location outside the tracked tree
    rmSync(join(dir, 'sub'), { recursive: true, force: true });
    symlinkSync(evilTarget, join(dir, 'sub'), 'dir');

    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `AC6b: a tracked leaf whose ancestor was replaced by a symlink must deny, never silently ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      existsSync(join(evilTarget, 'leaf.txt')),
      false,
      `AC6b: THE LOAD-BEARING PROPERTY — materialization must never write through the symlinked ancestor into the attacker-controlled target directory — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup([evilTarget]);
  }
});

// =========================================================================
// T11 — HARDLINK FIXTURE (HIGH-severity security-review finding, S3 fix).
// The load-bearing pin for: `materializeHeadBlob` now UNLINKS any existing
// leaf unconditionally before writing, so `writeRegularAt`'s existing-entry
// arm (which truncated IN PLACE) is unreachable from restore. Before the
// fix, a tracked path replaced by a HARDLINK to an arbitrary outside inode
// caused the restore's truncate-in-place write to land on that shared
// inode — i.e. HEAD's bytes got written to a file potentially OUTSIDE the
// repo.
//
// THE EXIT CODE IS NOT A CARRIER: a deny (exit 2) fires whether the fix is
// present or not, because the path is a violation either way. The verdict
// lives entirely in the OUTSIDE file's bytes and the tracked path's link
// count afterward.
//
// CONTROL (placed first, NO HOOK INVOLVED): reproduces the exact pre-fix
// primitive shape — `openSync(O_WRONLY|O_NOFOLLOW)` + `ftruncateSync` +
// `writeSync` on a hardlinked leaf — and proves it actually clobbers the
// linked outside file ON THIS HOST. Without this control, a green TREATMENT
// result is unfalsifiable: it would pass identically if hard links simply
// don't work on this filesystem (this repo may sit on a drvfs/9p mount).
//
// "Outside the repo" means outside the EPHEMERAL GIT PROJECT, so the victim is
// a tmpdir() sibling of it — same device by construction. It must NOT be placed
// beside the real checkout: on this host the checkout is drvfs and tmpdir() is
// ext4, so that pairing fails EXDEV before the primitive is ever exercised,
// which reads exactly like "hard links unsupported" from a bare exception and
// (at module scope) aborts every test in the file. HARDLINK_SKIP
// probes this exact pairing and fails loudly (never skips) on EXDEV.
//
// SABOTAGE: remove the unconditional unlink in `materializeHeadBlob` (or
// otherwise let it fall through to `writeRegularAt`'s pre-existing-entry
// truncate-in-place arm when the leaf already exists). Target:
// `materializeHeadBlob` in scripts/hooks/h17-bash-write-sweep.mjs — the call
// site that must unconditionally `unlinkSync`/equivalent the leaf before
// invoking `writeRegularAt`, so `writeRegularAt` always takes its
// `O_CREAT|O_EXCL` (fresh-inode) arm from this call path. With the unlink
// removed, T11's outside-bytes assertion flips red (the shared inode gets
// truncated+overwritten with HEAD bytes) and the nlink assertion flips red
// (the leaf still shares the outside file's inode instead of being a fresh
// one).
// =========================================================================

test('T11 CONTROL: on this host, the pre-fix truncate-in-place write primitive on a hardlinked leaf really does clobber the linked outside file (no H17 involved)', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-hlcontrol-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-hlcontrol-outside-'));
  try {
    const outsideFile = join(outsideDir, 'outside-control.bin');
    const distinctiveBytes = Buffer.from('CONTROL-DISTINCTIVE-OUTSIDE-BYTES-DO-NOT-TOUCH\n');
    writeFileSync(outsideFile, distinctiveBytes);

    const leaf = join(probeDir, 'leaf.txt');
    linkSync(outsideFile, leaf);

    // exact pre-fix primitive shape: open the EXISTING leaf and truncate it
    // in place — no unlink, no fresh inode.
    const fd = openSync(leaf, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    const newBytes = Buffer.from('CLOBBERED-BY-TRUNCATE-IN-PLACE\n');
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, newBytes, 0, newBytes.length, 0);
    } finally {
      closeSync(fd);
    }

    const after = readFileSync(outsideFile);
    assert.ok(
      !after.equals(distinctiveBytes),
      'CONTROL: writing through a hardlinked leaf via truncate-in-place must actually change the OUTSIDE file bytes on this host, or the TREATMENT test below proves nothing about the fix defending against it'
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('T11: a tracked enforcement path replaced by a HARDLINK to an outside file is restored without clobbering the shared inode', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-rb-outside-'));
  try {
    const P = bundlePath(dir);
    const head = readFileSync(P, 'utf8');
    const outsideFile = join(outsideDir, 'outside-target.bin');
    const distinctiveBytes = Buffer.from('OUTSIDE-INODE-DISTINCTIVE-BYTES-DO-NOT-TOUCH\n');
    writeFileSync(outsideFile, distinctiveBytes);

    const L = lane('t11-hardlink-restore');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    // the audited command's tampering: replace the tracked leaf with a
    // hardlink to an outside, attacker-reachable inode
    rmSync(P, { force: true });
    linkSync(outsideFile, P);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `T11: a tracked path replaced by a hardlink still denies — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);

    assert.deepEqual(
      readFileSync(outsideFile),
      distinctiveBytes,
      `T11: THE LOAD-BEARING PROPERTY — the OUTSIDE file's bytes must be UNTOUCHED; a truncate-in-place restore would have overwritten this shared inode with HEAD's bytes — stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(
      statSync(P).nlink,
      1,
      `T11: the tracked path must be a fresh inode (unlinked then recreated), not still sharing the outside file's inode — stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(P, 'utf8'), head, `T11: the tracked path holds HEAD's bytes after restore — stderr: ${oneLine(r.stderr)}`);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    cleanup();
  }
});

// =========================================================================
// T13 — MODE FIXTURE (second S3 security-review finding). A restored path
// could previously keep attacker-widened permission bits, because the old
// truncate-in-place write reused the existing inode's mode rather than
// creating a fresh entry. This is invisible to `git status`, which tracks
// only the executable bit — so the byte change in this fixture is essential;
// a bare chmod alone would never surface the path as dirty in the first
// place.
//
// SABOTAGE: same root cause as T11 — remove `materializeHeadBlob`'s
// unconditional unlink so `writeRegularAt` takes the truncate-in-place
// existing-entry arm, which preserves the pre-existing (attacker-widened)
// mode bits instead of creating a fresh entry with a non-widened mode.
// Target: `materializeHeadBlob` in scripts/hooks/h17-bash-write-sweep.mjs.
// With the unlink removed, the restored file keeps `0o777`'s group/other
// write bits and T13's mode assertion flips red.
// =========================================================================

test('T13: a tracked enforcement path is chmod 0777 AND its bytes changed; restore clears the widened permission bits', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const P = bundlePath(dir);
    const head = readFileSync(P, 'utf8');
    const L = lane('t13-mode-widen');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    // the byte change is essential: chmod alone does not make `git status`
    // report the path, which is exactly why this residual was invisible.
    writeFileSync(P, '// attacker-widened-mode tamper\n');
    chmodSync(P, 0o777);
    assert.equal(statSync(P).mode & 0o777, 0o777, 'PRECONDITION: the mode was actually widened before Post runs');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `T13: a genuinely new dirty tracked path restores+denies — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(P, 'utf8'), head, `T13: bytes restored to HEAD — stderr: ${oneLine(r.stderr)}`);

    const mode = statSync(P).mode & 0o777;
    assert.equal(
      mode & 0o022,
      0,
      `T13: THE LOAD-BEARING PROPERTY — restore must not leave attacker-widened group/other write bits (0o644-shaped) — actual mode 0o${mode.toString(8)}, stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// T14 — DENIAL WORDING. A non-regular HEAD entry (a committed symlink here;
// the same argument covers mode 120000 / a gitlink) is legitimate repo
// content, not a broken machine — mislabelling its refusal under the
// generic environment-defect wrapper invites a waiver rather than a fix
// (anti-pattern 586bccdc: a false claim about what protects a path is worse
// than the gap, because it stops the next reader looking).
//
// SABOTAGE: route the non-regular-HEAD-mode refusal through the generic
// fail-closed catch-all (throw an untyped Error caught by the
// "ENVIRONMENT DEFECT (H17): ... failing closed (P5)" composer) instead of
// emitting the dedicated "H17: NON-RESTORABLE HEAD ENTRY" denial directly.
// Target: the mode-check branch in restoreTracked's materializer,
// scripts/hooks/h17-bash-write-sweep.mjs (the same gate AC3 above pins
// functionally; this pin pins its WORDING). With the dedicated denial
// removed, the positive `/H17: NON-RESTORABLE HEAD ENTRY/` match flips red
// and the `doesNotMatch(/ENVIRONMENT DEFECT/i)` flips red too.
// =========================================================================

test('T14: a non-regular HEAD tree entry (a committed symlink) denies as "H17: NON-RESTORABLE HEAD ENTRY", never the ENVIRONMENT DEFECT wrapper', { skip: GIT_SKIP || SYMLINK_TRACK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const rel = 'tracked-link-t14.txt';
    const p = join(dir, rel);
    symlinkSync('nonexistent-target-t14.txt', p);
    git(dir, ['add', rel], { must: true });
    git(dir, ['commit', '-q', '-m', 'add tracked symlink for T14'], { must: true });

    const L = lane('t14-non-restorable-wording');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes a clean tree');

    rmSync(p, { force: true }); // remove the symlink entry itself
    writeFileSync(p, '// attacker replaced the symlink with a regular file\n');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `T14: a non-regular HEAD mode must still deny the violation — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    // Matches the WRAPPER form only — `ENVIRONMENT DEFECT (H17): ...` — not the
    // bare phrase. The denial deliberately says "This is NOT an environment
    // defect and NOT a broken machine", so a bare /ENVIRONMENT DEFECT/ fires on
    // the negation and the pin fails against CORRECT behaviour. Measured
    // 2026-08-29: that is exactly how this assertion first failed.
    assert.doesNotMatch(
      oneLine(r.stderr),
      /ENVIRONMENT DEFECT \(H17\)/i,
      `T14: a committed symlink is legitimate repo content, not a broken machine — it must never be reported under the environment-defect wrapper — stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      oneLine(r.stderr),
      /H17: NON-RESTORABLE HEAD ENTRY/,
      `T14: THE LOAD-BEARING PROPERTY — the denial must use the exact wording "H17: NON-RESTORABLE HEAD ENTRY" — stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
