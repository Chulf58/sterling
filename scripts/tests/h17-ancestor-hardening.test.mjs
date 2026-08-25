// H17 ANCESTOR HARDENING — board 128fedb7 (HIGH): H17's WRITE AND DELETE
// PRIMITIVES MUST GUARD THEIR ANCESTOR PATH COMPONENTS, and so must the stamp
// CLI that feeds H17 its attestations. Guarding the FINAL component is not
// enough when a PARENT directory can be a link: `mkdirSync(dirname(abs),
// {recursive:true})`, a recursive `rmSync`, a `git checkout HEAD -- <path>` and
// an `existsSync`/`readFileSync` pair all traverse (or follow) whatever sits on
// the way down.
//
// FOUR SITES, per the board item:
//   1. the (B) restore's WRITE primitive (writeUnder) — mkdir+write through a
//      linked ancestor;
//   2. the (B) "new entry" DELETE arm — a recursive rmSync whose path was
//      derived by walking THROUGH a linked ancestor, plus its leaf KIND;
//   3. restoreTracked — `git checkout HEAD -- <path>` / recursive rmSync on a
//      git-reported enforcement path with a linked ancestor;
//   4. scripts/enforcement-stamp.mjs — reads with existsSync/readFileSync
//      (which FOLLOW links), walks untracked directories, and writes its stamp
//      under `.sterling/transient/`, any component of which can be a link. The
//      stamp is the conductor's attestation INPUT, so poisoning what it reads
//      poisons an exemption.
//
// SCOPE, stated so a green here is not over-read: the board item names the
// check/use TOCTOU race (an lstat-then-write pair can be won by a concurrent
// process) as the part a portable Node implementation does NOT close — that is
// the accepted residual (2422e76a) and boarded separately (6c1e0890). Nothing
// in this file asserts race-freedom; every pin here is a same-process,
// deterministic fixture.
//
// EXPECTED STATE: the ancestor guards for board 128fedb7 have LANDED, so every
// pin in this file is expected GREEN. Each pin carries its own EXPECTED FAILURE
// SHAPE (which assertion fires, on what) and its one-line SABOTAGE — the change
// that must turn it RED — because a green suite is not evidence for a security
// guard (decision a-ruling-change-is-verified-by-mutation-not-by-a-green-suite).
//
// HOLLOWNESS DISCLOSURE, read this before trusting a green here. Several of
// these properties are defended in DEPTH: H17's Post re-runs the whole (B)
// collection as `current` BEFORE the restore/delete loop is entered, so an
// ancestor that is ALREADY a link at scan time is denied by the SCAN's own
// classification and the write/delete primitive's guard is never reached. That
// is real defense in depth for the TOCTOU window (the scan's verdict cannot
// cover an ancestor swapped AFTER it ran), not redundancy to be deleted — but
// it means a SINGLE-guard mutation may leave a pin green. Where that applies
// the pin names BOTH candidate guards and says the mutation battery must strip
// EVERY layer to tell defense-in-depth from hollowness. The pins are written so
// the OBSERVABLE security property (nothing outside the repo is created,
// written, or deleted; the deny is exit 2, never exit 1) holds whichever layer
// fires — that property is the oracle, not the identity of the guard.
//
// CAUSE ISOLATION (the control-arm discipline). A bare "it denied" can be true
// for the wrong reason, so:
//   * pins 1-3 put the swap INSIDE `.claude/agents/**`, which is gitignored, and
//     assert that git reports NOTHING — so the (A) tracked/untracked sweep
//     cannot be what denies. That is the trap the neighbouring
//     PIN-B-ANCESTOR-RESTORE-NO-MKDIR-THROUGH disclosed about itself: swapping
//     `.claude` makes a top-level UNTRACKED entry that the older (A) sweep
//     removes first, so that pin never reached the (B) primitive at all.
//   * pins 4-7 each carry a CONTROL ARM, PLACED FIRST, that must pass for the
//     OPPOSITE reason (the sweep/CLI really does reach and act on this path when
//     the ancestor is a REAL directory), so the treatment arm's refusal cannot
//     be satisfied by "this mode refuses everything" or "the code never looked".
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs and
// scripts/enforcement-stamp.mjs per H4 — no hook or CLI source was read; every
// expectation comes from board 128fedb7, the owning article's AC12-AC14, and
// the sibling pins' settled phase rule.
//
// HARNESS is a faithful copy of scripts/tests/h17-baseline-ancestor.test.mjs's
// idiom (makeGitProject, the Pre/Post pair sharing one tool_use_id per lane,
// oneLine, GIT_SKIP/SYMLINK_SKIP) — NOT imported, since that file exports
// nothing — extended with a tracked `hooks/sub/h3-extra.mjs` (pin 4 needs a
// TRACKED enforcement path whose ANCESTOR can be swapped) and a stamp-CLI
// runner (pins 5-7).
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-ancestor-hardening.test.mjs

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
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const STAMP_CLI = join(root, 'scripts', 'enforcement-stamp.mjs');
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

// P5: a check that cannot run says so, rather than failing or passing vacuously.
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

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

// the working tree as git reports it — used as a PRECONDITION, so a failure
// here is a fixture failure and must be loud (P5)
function porcelain(dir) {
  return git(dir, ['status', '--porcelain'], { must: true }).stdout;
}

const TRACKED_SUB_REL = 'hooks/sub/h3-extra.mjs';
const TRACKED_SUB_BYTES = '// a SECOND bundled enforcement hook, tracked, one directory down\nprocess.exit(0);\n';

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-anchard-'));
  const runId = 'r-h17ah-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');
  // pin 4 needs a TRACKED enforcement path one directory down, so its ANCESTOR
  // (`hooks/sub`) can be swapped for a link while the path itself stays tracked.
  writeFileSync(join(dir, ...TRACKED_SUB_REL.split('/')), TRACKED_SUB_BYTES);

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

// every temp file H17 owns for this project tag (per-call keys are not
// predictable from here, so they are swept by prefix)
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; the fixtures do the mutating
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

// One Bash call = one tool_use_id, carried by BOTH its Pre and its Post.
function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

function stampPath(dir) {
  return join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
}

// the conductor's attestation CLI, exactly as enforcement.test.mjs invokes it
function runStampCli(dir) {
  const r = spawnSync(process.execPath, [STAMP_CLI], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// recursive listing of an out-of-repo directory, as a sorted set of relative
// paths — the observable that says whether ANYTHING was created there
function treeOf(dirPath) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dirPath, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      const st = lstatSync(join(dirPath, r));
      if (st.isDirectory()) walk(r);
    }
  };
  walk('');
  return out.sort();
}

// =========================================================================
// PIN 1 — PIN-B-RESTORE-NO-WRITE-THROUGH-LINKED-ANCESTOR (board site 1,
// writeUnder). A (B) file recorded at Pre goes missing across the window, so
// the (B) stage's RECREATE arm fires; but by then its PARENT directory is a
// symlink to an out-of-repo directory, so `mkdirSync(dirname(abs),
// {recursive:true})` succeeds as a no-op (the directory already resolves) and
// the write lands OUTSIDE the repository, at a destination the audited command
// chose. A write primitive that can be AIMED is worse than one that can be
// evaded.
//
// CAUSE ISOLATION: the swap is at `.claude/agents/sub`, INSIDE the gitignored
// `.claude/agents/` tree, and the test asserts git reports NOTHING — so the (A)
// untracked-symlink sweep (which is what actually denied in the sibling
// PIN-B-ANCESTOR-RESTORE-NO-MKDIR-THROUGH, by its own disclosure) cannot be the
// cause here. Only the (B) stage covers this path.
//
// EXPECTED FAILURE SHAPE if the guard is absent: `treeOf(outsideDir)` comes back
// holding `coder.md` (the baseline bytes written through the link) — the
// `assert.deepEqual(treeOf(outsideDir), beforeTree, ...)` line fires with that
// extra entry; and/or `assert.equal(post.code, 2, ...)` fires with actual 0.
//
// SABOTAGE: delete `assertRealAncestors` from `writeUnder`.
// DEFENSE-IN-DEPTH CAVEAT (must be measured, not assumed): Post re-collects the
// whole (B) surface BEFORE the restore loop, and that scan's own ancestor
// classification also refuses this fixture — so the single sabotage above may
// leave this pin GREEN while still being a real regression for the TOCTOU
// window. The battery must strip BOTH the Post-scan ancestor classification and
// writeUnder's guard to see red, and should record which one carried the
// verdict. What this pin pins unconditionally is the OBSERVABLE: exit 2, and not
// one byte created or changed outside the repo.
// =========================================================================

test(
  'PIN-B-RESTORE-NO-WRITE-THROUGH-LINKED-ANCESTOR: a deleted (B) file whose PARENT is now a symlink is never recreated through it (gitignored path — the (A) sweep cannot be the cause)',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-write-'));
    try {
      const canary = Buffer.from('OUTSIDE-REPO CANARY — must never be modified, and nothing may be created beside it\n');
      writeFileSync(join(outsideDir, 'canary.txt'), canary);
      const beforeTree = treeOf(outsideDir);
      assert.deepEqual(beforeTree, ['canary.txt'], 'PRECONDITION: the outside directory holds exactly its canary — any new entry proves a write-through');

      // a NESTED (B) file, so the swapped ancestor is a directory INSIDE the
      // gitignored .claude/agents/ tree rather than a top-level entry git can see
      const agentsSub = join(dir, '.claude', 'agents', 'sub');
      mkdirSync(agentsSub, { recursive: true });
      writeFileSync(join(agentsSub, 'coder.md'), '# nested legit agent\n');

      const L = lane('write-through');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshots a real .claude/agents/sub/coder.md through real directories');

      // inside the window: the audited command deletes the nested directory and
      // re-points that ancestor at an out-of-repo destination it chose
      rmSync(agentsSub, { recursive: true, force: true });
      symlinkSync(outsideDir, agentsSub);
      assert.equal(lstatSync(agentsSub).isSymbolicLink(), true, 'PRECONDITION: the (B) file\'s PARENT is now a symlink, left there by the audited command');
      assert.equal(
        porcelain(dir),
        '',
        'PRECONDITION AND CAUSE ISOLATION: git reports nothing — .claude/agents/** is gitignored, so the (A) tracked/untracked sweep cannot be what denies here; only the (B) stage covers this path'
      );
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a (B) recreate whose PARENT is now a symlink must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.deepEqual(
        treeOf(outsideDir),
        beforeTree,
        'the out-of-repo directory reached through the linked ancestor gained NO entry — a write-through would leave `coder.md` (the baseline bytes) sitting in it'
      );
      assert.deepEqual(readFileSync(join(outsideDir, 'canary.txt')), canary, 'and the file already there is byte-unchanged');
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN 2 — PIN-B-DELETE-NO-UNLINK-THROUGH-LINKED-ANCESTOR (board site 2, the
// (B) "new entry" arm). The delete primitive is aimed the same way the write
// one is: the walk derives a child path BENEATH a linked directory and then
// `rmSync`s it, destroying an out-of-repo file (or, with {recursive:true}, an
// out-of-repo DIRECTORY TREE) that the audited command chose.
//
// FIXTURE, built so the delete arm is the ONLY (B) action derivable — otherwise
// a green could come from the recreate arm being refused instead:
//   * at Pre, `.claude/agents/sub/` is a REAL directory holding `keep.md`;
//   * the outside directory holds `keep.md` with BYTE-IDENTICAL content (so a
//     followed walk sees no MODIFIED and no DELETED entry to restore), plus
//     `evil.md` and a `evildir/inner.md` subtree that are NOT in the baseline
//     and are therefore "new entries" to be deleted;
//   * inside the window the audited command swaps `.claude/agents/sub` for a
//     symlink to that outside directory.
// A walk that follows the link sees `sub/evil.md` and `sub/evildir` as new (B)
// entries and unlinks / recursively removes them — outside the repository.
//
// CAUSE ISOLATION: as pin 1 — gitignored path, git reports nothing.
//
// EXPECTED FAILURE SHAPE if the guard is absent: `treeOf(outsideDir)` comes back
// MISSING `evil.md` (and/or `evildir`, `evildir/inner.md`) — the
// `assert.deepEqual(treeOf(outsideDir), beforeTree, ...)` line fires naming the
// entries that were destroyed; and/or `assert.equal(post.code, 2)` fires with
// actual 0.
//
// SABOTAGE (two, and they are different defects):
//   (a) delete `assertRealAncestors` from `removeUnder` — the derived child is
//       unlinked through the linked ancestor again;
//   (b) restore `{recursive:true}` on the new-entry rmSync AND let a DIRECTORY
//       leaf through — `evildir/` is then removed as a tree instead of denied,
//       which is why the fixture carries a directory as well as a file.
// DEFENSE-IN-DEPTH CAVEAT: same as pin 1 — the Post-time (B) scan's own ancestor
// classification also refuses this fixture, so a single-guard mutation may stay
// green; strip every layer and record which one carries the verdict.
// =========================================================================

test(
  'PIN-B-DELETE-NO-UNLINK-THROUGH-LINKED-ANCESTOR: a NEW (B) entry derived through a linked ancestor is never deleted — the out-of-repo file AND directory tree survive',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-delete-'));
    try {
      const keepBytes = Buffer.from('# nested legit agent\n');
      const evilBytes = Buffer.from('OUTSIDE-REPO FILE — a "new (B) entry" only if the walk follows the link; must SURVIVE\n');
      const innerBytes = Buffer.from('OUTSIDE-REPO FILE inside a DIRECTORY — a recursive rmSync would take the whole tree\n');

      const agentsSub = join(dir, '.claude', 'agents', 'sub');
      mkdirSync(agentsSub, { recursive: true });
      writeFileSync(join(agentsSub, 'keep.md'), keepBytes);

      writeFileSync(join(outsideDir, 'keep.md'), keepBytes); // byte-identical: no restore arm fires
      writeFileSync(join(outsideDir, 'evil.md'), evilBytes);
      mkdirSync(join(outsideDir, 'evildir'), { recursive: true });
      writeFileSync(join(outsideDir, 'evildir', 'inner.md'), innerBytes);
      const beforeTree = treeOf(outsideDir);
      assert.deepEqual(beforeTree, ['evil.md', 'evildir', 'evildir/inner.md', 'keep.md'], 'PRECONDITION: the outside tree is exactly the fixture');

      const L = lane('delete-through');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshots the real .claude/agents/sub/keep.md');

      rmSync(agentsSub, { recursive: true, force: true });
      symlinkSync(outsideDir, agentsSub);
      assert.equal(lstatSync(agentsSub).isSymbolicLink(), true, 'PRECONDITION: the ancestor is now a symlink, left there by the audited command');
      assert.equal(
        porcelain(dir),
        '',
        'PRECONDITION AND CAUSE ISOLATION: git reports nothing — the (A) sweep cannot be what denies here'
      );
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a (B) new-entry delete derived through a linked ancestor must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.deepEqual(
        treeOf(outsideDir),
        beforeTree,
        'the out-of-repo tree reached through the linked ancestor is INTACT — nothing unlinked, no directory removed recursively'
      );
      assert.deepEqual(readFileSync(join(outsideDir, 'evil.md')), evilBytes, 'the out-of-repo file the delete arm would have taken is byte-unchanged');
      assert.deepEqual(readFileSync(join(outsideDir, 'evildir', 'inner.md')), innerBytes, 'and so is the file inside the out-of-repo DIRECTORY a recursive rmSync would have taken');
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN 3 — PIN-B-NEW-ENTRY-SYMLINK-NOT-UNLINKED (board site 2's LEAF KIND, the
// other half of the delete arm). A (B) path that is ABSENT at Pre and is a
// SYMLINK at Post is a "new entry", so the delete arm claims it. The kind is in
// question, so per the settled phase rule (a kind transition across the window
// is CONDUCT, judged at Post) H17 must DENY and touch nothing — it must not
// "clean up" by unlinking the link, because the same code path that unlinks a
// link is the one that, one component up, deletes through one.
//
// Distinct from every sibling pin: PIN-B-SYMLINK-AT-PRE has the link present at
// PRE (denied on sight, environment defect); PIN-B-SYMLINK-DURING-WINDOW and
// PIN-B-NO-RESTORE-ON-TYPE-TRANSITION swap an EXISTING baselined file. This one
// is a path with NO baseline entry at all, which is the delete arm's input.
//
// CAUSE ISOLATION: `.claude/agents/evil.md` is gitignored; git reports nothing.
//
// EXPECTED FAILURE SHAPE if the kind check is absent: the link is gone —
// `assert.equal(lstatSync(evilLink).isSymbolicLink(), true, ...)` fires with
// actual false (or `existsSync` is already false and `lstatSync` throws ENOENT,
// reported as the same defect); and/or `assert.equal(post.code, 2)` fires with 0.
//
// SABOTAGE: drop `removeUnder`'s leaf-kind check, so a non-regular new entry is
// unlinked like any other.
// =========================================================================

test(
  'PIN-B-NEW-ENTRY-SYMLINK-NOT-UNLINKED: a NEW (B) entry that is a SYMLINK at Post denies and is left exactly as the command left it',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideTarget = join(tmpdir(), 'sterling-h17-ah-leaf-' + randomUUID().slice(0, 8));
    try {
      const outsideContent = Buffer.from('OUTSIDE-REPO TARGET of a symlink planted inside .claude/agents/ — must be untouched\n');
      writeFileSync(outsideTarget, outsideContent);

      const evilLink = join(dir, '.claude', 'agents', 'evil.md');
      assert.equal(existsSync(evilLink), false, 'PRECONDITION: the path is ABSENT at Pre, so at Post it is a NEW (B) entry — the delete arm\'s input');

      const L = lane('new-entry-symlink');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshots a clean (B) surface');

      symlinkSync(outsideTarget, evilLink); // the audited command plants a link where no (B) entry existed
      assert.equal(lstatSync(evilLink).isSymbolicLink(), true, 'PRECONDITION: the new (B) entry is a symlink');
      assert.equal(porcelain(dir), '', 'PRECONDITION AND CAUSE ISOLATION: git reports nothing — the (A) sweep cannot be what denies here');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a NEW (B) entry that is a symlink must deny on its KIND — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.equal(
        lstatSync(evilLink).isSymbolicLink(),
        true,
        'the link itself must still be exactly what the audited command left there — the delete arm must refuse a non-regular leaf, not unlink it'
      );
      assert.equal(readlinkSync(evilLink), outsideTarget, 'and its target is unchanged — never re-pointed');
      assert.deepEqual(readFileSync(outsideTarget), outsideContent, 'and the out-of-repo target is byte-unchanged');
    } finally {
      cleanup([outsideTarget]);
    }
  }
);

// =========================================================================
// PIN 4 — PIN-A-TRACKED-RESTORE-NO-CHECKOUT-THROUGH-LINKED-ANCESTOR (board
// site 3, restoreTracked). `git checkout HEAD -- <path>` is a WRITE primitive
// too: point a tracked enforcement path's ANCESTOR at an out-of-repo directory
// and the restore recreates the file THERE.
//
// CONTROL ARM FIRST, and it must pass for the OPPOSITE reason: with `hooks/sub`
// a REAL directory, deleting the tracked `hooks/sub/h3-extra.mjs` in-window is
// denied AND the file is byte-restored from HEAD. That is what proves the (A)
// sweep reaches this path and that its restore primitive really does write
// there — without it, the treatment arm's "nothing appeared outside" could be
// satisfied by a sweep that never looked at the path at all.
//
// TREATMENT ARM: same fixture, but the audited command replaces `hooks/sub`
// with a symlink to an out-of-repo directory. The tracked file is still
// "missing" from git's point of view, so the same restore fires — and must
// refuse rather than write `h3-extra.mjs` into the outside directory.
//
// DEVIATION FROM THE WORK ORDER, disclosed rather than silently swapped: the
// order suggested an untracked `hooks/newdir/evil.mjs` whose directory becomes a
// link. That shape is WEAK for this site — `rmSync` on a symlink PATH unlinks
// the link and never follows it, so the outside tree survives even under an
// unguarded implementation and the pin would be green for a reason that has
// nothing to do with the guard (the sibling
// PIN-B-ANCESTOR-RESTORE-NO-MKDIR-THROUGH documents exactly that trap). A
// TRACKED file under a swapped ancestor is the shape where restoreTracked
// actually WRITES, so that is what this pins.
//
// EXPECTED FAILURE SHAPE if the guard is absent: `treeOf(outsideDir)` comes back
// holding `h3-extra.mjs` — the `assert.deepEqual(treeOf(outsideDir),
// beforeTree, ...)` line fires with that extra entry.
//
// SABOTAGE: delete `assertRealAncestors` from `restoreTracked`.
// RESIDUAL CAUSE, disclosed (this pin's green has more than one possible cause
// and the control arm does not close all of them): git's own worktree
// protections may refuse to check a path out through a symlinked directory, and
// the (A) sweep may unlink the untracked symlink at `hooks/sub` before the
// restore runs. Either would keep the outside tree intact without H17's guard
// existing. The mutation battery must therefore confirm this pin goes RED under
// the named sabotage; if it does not, the honest disposition is to record it as
// a safety-net pin (the shape the sibling file uses) rather than a guard pin.
// =========================================================================

test(
  'PIN-A-TRACKED-RESTORE-NO-CHECKOUT-THROUGH-LINKED-ANCESTOR: CONTROL — a deleted tracked enforcement path under a REAL directory is denied AND restored from HEAD',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const tracked = join(dir, 'hooks', 'sub', 'h3-extra.mjs');
      assert.equal(readFileSync(tracked, 'utf8'), TRACKED_SUB_BYTES, 'PRECONDITION: the tracked enforcement path is committed and pristine');

      const L = lane('tracked-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree');

      rmSync(tracked, { force: true }); // the audited command deletes it, ancestor left a REAL directory
      assert.match(porcelain(dir), /h3-extra\.mjs/, 'PRECONDITION: git reports the deletion, so the (A) sweep has this path in front of it');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny lands on the restore arm, never the attested arm');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `deleting a tracked enforcement path in-window must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.equal(
        existsSync(tracked),
        true,
        'CONTROL: the restore primitive really does write to this path when its ancestor is a REAL directory — this is what stops the treatment arm below from passing because the sweep never looked'
      );
      assert.equal(readFileSync(tracked, 'utf8'), TRACKED_SUB_BYTES, 'and it is byte-restored from HEAD');
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-A-TRACKED-RESTORE-NO-CHECKOUT-THROUGH-LINKED-ANCESTOR: a tracked enforcement path whose ANCESTOR is now a symlink is never checked out through it',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-tracked-'));
    try {
      const canary = Buffer.from('OUTSIDE-REPO CANARY — a git checkout must never land beside this\n');
      writeFileSync(join(outsideDir, 'canary.txt'), canary);
      const beforeTree = treeOf(outsideDir);

      const subDir = join(dir, 'hooks', 'sub');
      const L = lane('tracked-linked');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree, with hooks/sub a REAL directory');

      // inside the window: the audited command removes the directory holding a
      // TRACKED enforcement file and points that ancestor out of the repository
      rmSync(subDir, { recursive: true, force: true });
      symlinkSync(outsideDir, subDir);
      assert.equal(lstatSync(subDir).isSymbolicLink(), true, 'PRECONDITION: the tracked path\'s ancestor is now a symlink');
      assert.match(porcelain(dir), /h3-extra\.mjs|sub/, 'PRECONDITION: git still reports the tracked path (or its ancestor) as changed, so the (A) sweep reaches the restore');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a tracked restore whose ancestor is a symlink must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.deepEqual(
        treeOf(outsideDir),
        beforeTree,
        'the out-of-repo directory gained NO entry — a checkout through the linked ancestor would leave `h3-extra.mjs` in it'
      );
      assert.deepEqual(readFileSync(join(outsideDir, 'canary.txt')), canary, 'and the file already there is byte-unchanged');
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN 5 — PIN-STAMP-NO-READ-THROUGH-LINK (board site 4, the READ half). The
// stamp is the conductor's ATTESTATION INPUT: H17 allows an in-window change
// whose current bytes match a fresh stamp entry. So a stamp CLI that reads a
// dirty path with existsSync/readFileSync — both of which FOLLOW links —
// attests OUT-OF-REPO bytes as if they were the enforcement file's own, and the
// attestation then exempts them.
//
// CONTROL ARM FIRST, passing for the OPPOSITE reason: the same dirty path as a
// REGULAR FILE produces a `{path, sha256}` entry whose digest is the file's own
// bytes. Without it, the treatment arm's "no stamp was written" could be
// satisfied by a CLI that refuses everything (or by a CLI that never considered
// this path at all).
//
// EXPECTED FAILURE SHAPE if the lstat guard is absent: the CLI succeeds through
// the link — `assert.notEqual(r.status, 0, ...)` fires with actual 0, and the
// follow-up `assert.equal(existsSync(stampPath(dir)), false, ...)` fires because
// a stamp file exists holding the sha256 of the OUTSIDE bytes.
//
// SABOTAGE: revert the lstat-guarded read to the `existsSync`/`readFileSync`
// pair.
// =========================================================================

test('PIN-STAMP-NO-READ-THROUGH-LINK: CONTROL — a dirty REGULAR enforcement file is stamped with the sha256 of its own bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const dirty = Buffer.from('// conductor rebuild, dirty and attestable\n');
    writeFileSync(bundle, dirty);

    const r = runStampCli(dir);
    assert.equal(r.status, 0, `CONTROL: the CLI must stamp a dirty regular enforcement file — status ${r.status}, stderr: ${oneLine(r.stderr)}`);
    const stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8'));
    const entry = stamp.find((e) => e?.path === 'hooks/h3-contract-gate.mjs');
    assert.ok(entry, `CONTROL: the dirty path is in the stamp (entries: ${stamp.map((e) => e?.path).join(', ')})`);
    assert.equal(entry.sha256, sha256(dirty), "CONTROL: and the digest is the file's OWN bytes — so this CLI does read and attest this path");
  } finally {
    cleanup();
  }
});

test('PIN-STAMP-NO-READ-THROUGH-LINK: the same path as a SYMLINK to an out-of-repo file is never read through — the CLI refuses and writes NO stamp', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideTarget = join(tmpdir(), 'sterling-h17-ah-stampread-' + randomUUID().slice(0, 8));
  try {
    const outsideContent = Buffer.from('OUTSIDE-REPO BYTES — attesting these would exempt content no sweep covers\n');
    writeFileSync(outsideTarget, outsideContent);

    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    rmSync(bundle, { force: true });
    symlinkSync(outsideTarget, bundle);
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: the dirty enforcement path is a symlink out of the repo');
    assert.notEqual(porcelain(dir), '', 'PRECONDITION: git reports the path as changed, so the CLI has exactly the same input as the control arm');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists yet, so any stamp found below was written by THIS run');

    const r = runStampCli(dir);

    assert.notEqual(r.status, 0, `a non-regular dirty path is UNATTESTABLE — the CLI must refuse, not follow the link (stdout+stderr: ${oneLine(r.stdout + ' ' + r.stderr)})`);
    assert.equal(
      existsSync(stampPath(dir)),
      false,
      `no stamp may be written at all — an attestation covering out-of-repo bytes is worse than none (stdout+stderr: ${oneLine(r.stdout + ' ' + r.stderr)})`
    );
    assert.notEqual(oneLine(r.stdout + ' ' + r.stderr), '', 'and the refusal says something (P5: never a silent nonzero)');
    assert.deepEqual(readFileSync(outsideTarget), outsideContent, 'the out-of-repo target is byte-unchanged');
  } finally {
    cleanup([outsideTarget]);
  }
});

// =========================================================================
// PIN 6 — PIN-STAMP-WALK-REJECTS-LINKED-CHILD (board site 4, the WALK). The
// CLI expands a dirty UNTRACKED DIRECTORY into its contained files (git
// collapses it into one porcelain entry). That walk must classify each entry it
// meets: a symlink-to-a-directory child is a door out of the repository, and
// following it stamps a tree no sweep covers.
//
// CONTROL ARM FIRST: the same untracked directory WITHOUT the link is stamped
// per-file, so a refusal in the treatment arm is discriminating rather than "the
// CLI refuses this fixture".
//
// EXPECTED FAILURE SHAPE if the guard is absent: the CLI exits 0 and the stamp
// holds entries reached through the link — `assert.notEqual(r.status, 0, ...)`
// fires with actual 0, and the no-stamp assertion fires naming the entries.
//
// RULING THIS PIN MAKES EXPLICIT (so a red is read correctly rather than
// "fixed" by loosening the test): the refusal is WHOLESALE — no stamp file at
// all. A partial stamp written from a walk that met an unclassifiable entry is
// an attestation of unknown provenance, which is exactly the poisoned input the
// board item names. If the implementation instead skips the link and stamps the
// regular sibling, THIS assertion is what fires, and the disposition question
// (refuse wholesale vs skip-and-continue) goes back to the conductor rather than
// being settled by editing the pin.
//
// SABOTAGE: delete the `isSymbolicLink()` branch in `listFilesUnder`.
// =========================================================================

test('PIN-STAMP-WALK-REJECTS-LINKED-CHILD: CONTROL — a dirty untracked enforcement directory of regular files stamps per-file', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const aBytes = Buffer.from('// untracked enforcement-surface file, uncommitted\n');
    writeFileSync(join(newDir, 'a.mjs'), aBytes);

    const r = runStampCli(dir);
    assert.equal(r.status, 0, `CONTROL: an untracked enforcement directory of regular files is attestable — status ${r.status}, stderr: ${oneLine(r.stderr)}`);
    const stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8'));
    const entry = stamp.find((e) => e?.path === 'hooks/newdir/a.mjs');
    assert.ok(entry, `CONTROL: the walk reaches the contained file (entries: ${stamp.map((e) => e?.path).join(', ')})`);
    assert.equal(entry.sha256, sha256(aBytes), 'CONTROL: and stamps its own bytes — so the walk really does descend into this directory');
  } finally {
    cleanup();
  }
});

test('PIN-STAMP-WALK-REJECTS-LINKED-CHILD: a symlink-to-an-outside-directory inside that dirty untracked directory makes the CLI refuse — nothing is stamped', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-stampwalk-'));
  try {
    const secret = Buffer.from('OUTSIDE-REPO CONTENT — must never be enumerated or attested\n');
    writeFileSync(join(outsideDir, 'secret.txt'), secret);
    const beforeTree = treeOf(outsideDir);

    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'a.mjs'), '// untracked enforcement-surface file, uncommitted\n');
    symlinkSync(outsideDir, join(newDir, 'link'));
    assert.equal(lstatSync(join(newDir, 'link')).isSymbolicLink(), true, 'PRECONDITION: a symlink to an outside DIRECTORY sits inside the dirty untracked directory');
    assert.match(porcelain(dir), /newdir/, 'PRECONDITION: git reports the untracked directory, the same input the control arm gave the CLI');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists yet');

    const r = runStampCli(dir);

    assert.notEqual(r.status, 0, `an unclassifiable entry in the walk makes the whole attestation untrustworthy — the CLI must refuse (stdout+stderr: ${oneLine(r.stdout + ' ' + r.stderr)})`);
    assert.equal(
      existsSync(stampPath(dir)),
      false,
      `NOTHING may be stamped — not even the regular sibling: a partial attestation from a walk that met a door out of the repo is the poisoned input board 128fedb7 names (stdout+stderr: ${oneLine(r.stdout + ' ' + r.stderr)})`
    );
    assert.deepEqual(treeOf(outsideDir), beforeTree, 'and the outside directory is untouched');
    assert.deepEqual(readFileSync(join(outsideDir, 'secret.txt')), secret, 'byte for byte');
  } finally {
    cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// =========================================================================
// PIN 7 — PIN-STAMP-NO-WRITE-THROUGH-LINKED-STERLING (board site 4, the WRITE).
// The CLI's own output path — `.sterling/transient/enforcement-stamp.json` — is
// created with a recursive mkdir, so any component of it can be a link the
// agent planted; the stamp then lands outside the repository (and, worse, the
// attestation the conductor believes it wrote does not exist where H17 reads
// it).
//
// CONTROL ARM FIRST: with `.sterling/transient` absent (the normal case, a real
// directory the CLI creates itself) the same dirt IS stamped at the expected
// path — so the treatment arm's refusal is not "this CLI refuses this dirt".
// `.sterling` ITSELF is deliberately not swapped: that would take
// `sterling.db`/`config.json` with it and confound the result with a
// store-resolution failure (the same reasoning the sibling ancestor file states).
//
// EXPECTED FAILURE SHAPE if the pre-write classification is absent: the CLI
// exits 0 and `existsSync(join(outsideDir, 'enforcement-stamp.json'))` is true —
// the `assert.deepEqual(treeOf(outsideDir), beforeTree, ...)` line fires with
// that extra entry, and `assert.notEqual(r.status, 0, ...)` fires with actual 0.
//
// SABOTAGE: delete the pre-write `classifyPathComponents` calls.
// =========================================================================

test('PIN-STAMP-NO-WRITE-THROUGH-LINKED-STERLING: CONTROL — the CLI creates .sterling/transient itself and writes the stamp inside the repo', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// conductor rebuild, dirty and attestable\n');
    assert.equal(existsSync(join(dir, '.sterling', 'transient')), false, 'PRECONDITION: .sterling/transient does not exist yet — the CLI creates it');

    const r = runStampCli(dir);
    assert.equal(r.status, 0, `CONTROL: this dirt is attestable — status ${r.status}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(stampPath(dir)), true, 'CONTROL: and the stamp lands at .sterling/transient/enforcement-stamp.json inside the repo');
  } finally {
    cleanup();
  }
});

test('PIN-STAMP-NO-WRITE-THROUGH-LINKED-STERLING: with .sterling/transient a symlink to an outside directory the CLI refuses — no stamp is created in the link target', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-stampwrite-'));
  try {
    const beforeTree = treeOf(outsideDir);
    assert.deepEqual(beforeTree, [], 'PRECONDITION: the outside directory starts EMPTY — any entry proves a write-through');

    writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// conductor rebuild, dirty and attestable\n'); // same dirt as the control arm
    const transient = join(dir, '.sterling', 'transient');
    symlinkSync(outsideDir, transient);
    assert.equal(lstatSync(transient).isSymbolicLink(), true, 'PRECONDITION: the stamp\'s parent directory is a symlink out of the repo');

    const r = runStampCli(dir);

    assert.notEqual(r.status, 0, `the CLI must refuse to write its attestation through a linked ancestor (stdout+stderr: ${oneLine(r.stdout + ' ' + r.stderr)})`);
    assert.deepEqual(
      treeOf(outsideDir),
      beforeTree,
      'no enforcement-stamp.json (nor anything else) may be created inside the link target — the conductor would believe it stamped a path H17 never reads'
    );
    assert.equal(existsSync(join(outsideDir, 'enforcement-stamp.json')), false, 'stated directly as well as by the tree comparison, because this is the whole point of the pin');
  } finally {
    cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// #########################################################################
// ##  PINS 8-9 — ROSTER REVIEW F4: restoreTracked's TWO OTHER PRIMITIVES ##
// #########################################################################
//
// PIN 4 above pins restoreTracked's GIT-CHECKOUT arm (a TRACKED file, deleted,
// whose ancestor is a linked directory). Roster finding F4 names two sibling
// primitives restoreTracked's no-leaf-restriction safety rests on that PIN 4
// never exercises: its own RMSYNC arm (used when the git-reported path has no
// HEAD version to check out — a genuinely new, untracked entry) under a
// linked ancestor, and the KIND-BLINDNESS of its unlink step at a TRACKED path
// (it must remove whatever occupies the path — file, dir, or symlink — before
// restoring, never refuse or skip based on what it finds there). Both are
// verify-at-build class: they pin PRIMITIVE node/git behavior restoreTracked's
// design already depends on, so both are expected GREEN against current HEAD,
// same as every other pin in this file.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4, same as
// every pin above. The restoreTracked-has-two-arms shape (git checkout for a
// path present in HEAD, rmSync for one that is not) is inferred from the
// PIN-CHILD-ABSENT-FROM-RECORD and PIN-CHILD-SURVIVES-STAGE/control fixtures
// in scripts/tests/h17-pre-state-snapshot.test.mjs — both show a genuinely new
// untracked enforcement-surface write, with no pre-dirty ancestor recorded at
// Pre, denied AND swept (`existsSync(fresh) === false`) at Post — which is
// restoreTracked's rmSync arm reached through the SAME `restoreTracked(cwd,
// p); violations.push(rel); restoredPaths.push(rel);` call site PIN 4 already
// exercises for a HEAD-tracked path. No hook source was read to confirm this;
// if the two arms turn out not to share one function, that is itself a finding
// to report, not a reason to weaken either pin.
// =========================================================================

// =========================================================================
// PIN 8 — PIN-A-UNTRACKED-RESTORE-NO-RMSYNC-THROUGH-LINKED-ANCESTOR (board
// site 3, restoreTracked's RMSYNC arm). A genuinely new, untracked
// enforcement-surface file has no HEAD version, so the violation-restore call
// takes the rmSync arm instead of `git checkout`. If that arm derives the
// absolute path by joining onto a parent directory that is now a symlink, an
// unguarded `rmSync` follows it and destroys whatever the audited command's
// own ancestor swap pointed at outside the repository — the same "a write
// primitive that can be aimed is worse than one that can be evaded" hazard PIN
// 1/2 pin for the (B) stage, now for the (A) stage's own delete primitive.
//
// FIXTURE SHAPE, chosen to avoid the WEAK shape PIN 4's header discloses
// about itself: the new file is `git add -A` STAGED before the ancestor swap,
// so its full nested path (not just the ancestor's own symlinked name) stays
// the git-reported violation across the window. Without staging, an untracked
// directory collapses to one porcelain entry that itself becomes the symlink
// at swap time, and `rmSync` on a symlink PATH unlinks the link without
// following it — a pin that would go green for a reason that has nothing to
// do with the ancestor guard, exactly the trap PIN 4 names.
//
// CONTROL ARM FIRST, passing for the OPPOSITE reason: the identical fixture
// with the ancestor left a REAL directory is denied AND the new file is
// removed — proving the rmSync arm really does reach and remove a path
// shaped like this one, so the treatment arm's "nothing appeared outside"
// cannot be explained by an arm that was never reached.
//
// EXPECTED FAILURE SHAPE if the guard is absent: `treeOf(outsideDir)` comes
// back MISSING `evil.mjs` (unlinked through the linked ancestor) — the
// `assert.deepEqual(treeOf(outsideDir), beforeTree, ...)` line fires naming
// the removed entry; and/or `assert.equal(post.code, 2)` fires with actual 0.
//
// SABOTAGE: delete `assertRealAncestors` from restoreTracked's rmSync arm —
// the derived child is unlinked through the linked ancestor.
// DEFENSE-IN-DEPTH CAVEAT: as stated file-wide above, if the (A) sweep also
// classifies ancestors during its OWN git-status collection pass (before
// calling restoreTracked at all), a single-guard mutation may leave this pin
// green without restoreTracked's own guard being what fired. The mutation
// battery must confirm which layer carries the verdict; what this pin pins
// unconditionally is the OBSERVABLE: exit 2, and the same-named outside file
// surviving byte-for-byte.
// =========================================================================

test(
  'PIN-A-UNTRACKED-RESTORE-NO-RMSYNC-THROUGH-LINKED-ANCESTOR: CONTROL — a genuinely new untracked enforcement path under a REAL ancestor directory is denied AND removed by restoreTracked\'s rmSync arm',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      assert.equal(porcelain(dir), '', 'PRECONDITION: the tree is clean — hooks/newdir-a does not exist yet at Pre');
      const L = lane('untracked-rm-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree');

      const newDir = join(dir, 'hooks', 'newdir-a');
      mkdirSync(newDir, { recursive: true });
      const fresh = join(newDir, 'evil.mjs');
      writeFileSync(fresh, "// genuinely new untracked enforcement file, created inside this command's own window\n");
      git(dir, ['add', '-A'], { must: true });
      assert.match(porcelain(dir), /A\s+hooks\/newdir-a\/evil\.mjs/, 'PRECONDITION: the new file is staged and individually visible, not present in HEAD');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the restore arm, never the attested arm');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a genuinely new untracked enforcement write must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.equal(
        existsSync(fresh),
        false,
        "CONTROL: restoreTracked's rmSync arm really does remove this path when its ancestor is a REAL directory — this is what stops the treatment arm below from passing because the arm never reached the path at all"
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-A-UNTRACKED-RESTORE-NO-RMSYNC-THROUGH-LINKED-ANCESTOR: a genuinely new untracked enforcement path whose ANCESTOR is now a symlink is never rmSync-ed through it',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-ah-untrackedrm-'));
    try {
      const outsideBytes = Buffer.from('OUTSIDE-REPO FILE, same-named as the swept leaf — must SURVIVE an rmSync through the linked ancestor\n');
      writeFileSync(join(outsideDir, 'evil.mjs'), outsideBytes);
      const beforeTree = treeOf(outsideDir);
      assert.deepEqual(beforeTree, ['evil.mjs'], 'PRECONDITION: the outside directory holds exactly its same-named file — any change proves a destructive descent');

      const newDir = join(dir, 'hooks', 'newdir-a');
      const L = lane('untracked-rm-linked');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree — hooks/newdir-a does not exist yet');

      // inside the window: the audited command creates a genuinely new
      // untracked enforcement file, stages it (so its full nested path stays
      // the git-reported violation), then re-points its ANCESTOR directory
      // out of the repository, leaving a same-named file sitting there
      mkdirSync(newDir, { recursive: true });
      writeFileSync(join(newDir, 'evil.mjs'), '// genuinely new untracked enforcement file\n');
      git(dir, ['add', '-A'], { must: true });
      assert.match(porcelain(dir), /A\s+hooks\/newdir-a\/evil\.mjs/, 'PRECONDITION: staged and individually visible, same shape as the control');

      rmSync(newDir, { recursive: true, force: true });
      symlinkSync(outsideDir, newDir);
      assert.equal(lstatSync(newDir).isSymbolicLink(), true, "PRECONDITION: the new entry's ANCESTOR directory is now a symlink, left there by the audited command");
      assert.match(porcelain(dir), /evil\.mjs|newdir-a/, 'PRECONDITION: git still reports the staged path (or its ancestor) as changed, so the (A) sweep has it in front of it');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `restoreTracked's rmSync arm on a new entry whose ancestor is a linked directory must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.deepEqual(
        treeOf(outsideDir),
        beforeTree,
        'the out-of-repo directory reached through the linked ancestor is INTACT — an unguarded rmSync would have removed the same-named file sitting there'
      );
      assert.deepEqual(readFileSync(join(outsideDir, 'evil.mjs')), outsideBytes, 'and the file itself is byte-unchanged');
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN 9 — PIN-A-TRACKED-RESTORE-LEAF-KIND-NOT-RESTRICTED (board site 3,
// restoreTracked's KIND-BLINDNESS). A TRACKED enforcement path is replaced,
// in-window, by a SYMLINK to an outside file — a KIND transition on a path
// git still reports as changed. Per the settled phase rule (a kind transition
// across the window is CONDUCT, judged at Post — the same rule PIN 3 states
// for the (B) stage's delete arm), H17 must deny; the question this pin adds
// is what restoreTracked does to the LEAF ITSELF while denying. It must
// remove it unconditionally and then restore from HEAD, applying NO
// restriction on what kind of thing it finds occupying the path — a
// `kind !== 'file'` refusal would instead leave the planted link in place,
// which is the exact regression the no-leaf-restriction design avoids (a
// leaf-kind check is one component away from becoming the same "route
// through the leaf" hazard PIN 3 pins for removeUnder).
//
// FIXTURE reuses TRACKED_SUB_REL/TRACKED_SUB_BYTES — the same tracked path
// PIN 4's CONTROL arm already proves restoreTracked's checkout-and-restore
// mechanism reaches under a REAL ancestor (there, via full deletion). `hooks/
// sub` stays a REAL directory throughout THIS pin — only the LEAF's kind
// changes — so PIN 4's control is this pin's control on the "does
// restoreTracked reach this path" question; this pin isolates the KIND
// dimension PIN 4 never varies.
//
// EXPECTED FAILURE SHAPE if a kind check refuses instead of removing: the
// planted link survives — `assert.equal(lstatSync(tracked).isSymbolicLink(),
// false, ...)` fires with actual true, and the two follow-up assertions
// (existence as a regular file, HEAD bytes) never get a chance to matter.
// If instead the deny simply never happens: `assert.equal(post.code, 2)`
// fires with actual 0.
//
// SABOTAGE: add a `kind !== 'file'` refusal to restoreTracked (deny without
// touching the path) — the planted link survives.
// =========================================================================

test(
  'PIN-A-TRACKED-RESTORE-LEAF-KIND-NOT-RESTRICTED: a tracked enforcement path replaced by a SYMLINK to an outside file is unlinked, not followed, and restored to pristine HEAD bytes',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideTarget = join(tmpdir(), 'sterling-h17-ah-leafkind-' + randomUUID().slice(0, 8));
    try {
      const outsideContent = Buffer.from('OUTSIDE-REPO TARGET of a symlink planted AT a tracked enforcement path — must be untouched by the restore\n');
      writeFileSync(outsideTarget, outsideContent);

      const tracked = join(dir, ...TRACKED_SUB_REL.split('/'));
      assert.equal(readFileSync(tracked, 'utf8'), TRACKED_SUB_BYTES, 'PRECONDITION: the tracked enforcement path is committed and pristine');

      const L = lane('leafkind');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree — hooks/sub is a REAL directory throughout this pin; only the LEAF kind changes (see PIN 4 for the ancestor dimension)');

      // inside the window: the audited command removes the tracked file and
      // plants a symlink to an outside file in its place — a KIND transition,
      // not a content edit and not a plain deletion
      rmSync(tracked, { force: true });
      symlinkSync(outsideTarget, tracked);
      assert.equal(lstatSync(tracked).isSymbolicLink(), true, 'PRECONDITION: the tracked enforcement path is now a symlink');
      assert.match(porcelain(dir), /h3-extra\.mjs/, 'PRECONDITION: git reports the tracked path as changed (a type change), so the (A) sweep has it in front of it');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the restore arm, never the attested arm');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a tracked enforcement path swapped for a symlink must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.equal(
        lstatSync(tracked).isSymbolicLink(),
        false,
        'THE PIN: the planted link must be UNLINKED, not left in place — restoreTracked applies no leaf-kind restriction, it removes whatever occupies the path before restoring from HEAD'
      );
      assert.equal(existsSync(tracked), true, 'and the path exists again, restored');
      assert.equal(readFileSync(tracked, 'utf8'), TRACKED_SUB_BYTES, 'restored byte-for-byte from HEAD — proving the checkout ran AFTER the unlink, never a write through the link');
      assert.deepEqual(readFileSync(outsideTarget), outsideContent, 'and the outside target the link pointed at is byte-unchanged — the unlink removed the link itself, it never followed it');
    } finally {
      cleanup([outsideTarget]);
    }
  }
);
