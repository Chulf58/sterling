// H17 (B) STAGE — GITIGNORED-BASELINE SYMLINK DEFECT (board 8b53dc84, HIGH).
//
// THE DEFECT THIS FILE PINS. H17's (B) stage guards three GITIGNORED
// enforcement paths git never reports: .claude/agents/** (recursive),
// .claude/settings*.json (top level only), .sterling/config.json. At
// PreToolUse it snapshots their CONTENT to an OS-temp baseline; at
// PostToolUse it re-reads them, compares, and RESTORES any difference
// (rewriting modified files, recreating deleted ones, deleting ones that
// appeared). collectBaseline and the restore both FOLLOW SYMLINKS:
//   * READ: a symlink planted at a (B) path is read THROUGH at Pre, so the
//     baseline captures out-of-repo content as the enforcement file's own —
//     and a symlink to a DIRECTORY under .claude/agents/** gets WALKED INTO,
//     so the snapshot can enumerate/read a tree outside the repository.
//   * WRITE (the serious half): the restore writes baseline content THROUGH
//     the link, to a destination the agent chose, OUTSIDE the repository —
//     the agent supplies the destination and H17 performs the write. A guard
//     that can be AIMED is worse than one that can be evaded.
// A second, independent defect in the same comparison: (B) compares files as
// UTF-8 STRINGS, which is lossy exactly where tampering hides — two
// DIFFERENT invalid-UTF-8 byte sequences can both decode to U+FFFD, so a
// tamper confined to invalid bytes compares EQUAL and is neither restored
// nor denied. The (A) side already moved to a raw-byte sha256; the two
// halves of one hook currently disagree about what "unchanged" means.
//
// EXPECTED TODAY: the four pins below are RED — measured by the coordinator
// against the live hook, on every axis including the write primitive. That
// is the point of a FROZEN pin authored against a live, undecided defect
// (per decision a-ruling-change-is-verified-by-mutation-not-by-a-green-suite,
// cf863d84 — verification is by mutation, not by a green suite, so a
// would-be fix must be checked against the named one-line sabotage before it
// is trusted).
//
// PHASE RULE, SETTLED (coordinator ruling, after outside review): a (B) path
// that is ALREADY a non-regular file AT PRE is an ENVIRONMENT DEFECT that
// predates the command — PRE denies (blocking before the command runs is
// strictly safer than snapshotting something we refuse to trust and then
// discovering it at Post). A KIND TRANSITION ACROSS THE WINDOW is CONDUCT —
// POST denies. PIN-B-SYMLINK-AT-PRE and PIN-B-SYMLINKED-DIRECTORY therefore
// assert PRE specifically; PIN-B-SYMLINK-DURING-WINDOW and
// PIN-B-NO-RESTORE-ON-TYPE-TRANSITION assert POST specifically. A candidate
// "honour a pre-existing symlink instead of denying at Pre" design was
// considered and REFUTED by outside review: an allowed command can write
// THROUGH such a link while the link itself stays unchanged, so Post would
// see nothing — which is exactly why Pre must deny on sight.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// source was read to write these pins; every expectation below comes from
// the board item's specification, not from the code.
//
// HARNESS is a faithful copy of scripts/tests/h17-pre-state-snapshot.test.mjs's
// idiom (makeGitProject, the Pre/Post invocation shape sharing one
// tool_use_id per lane, oneLine, GIT_SKIP) — NOT imported from that file,
// since it exports nothing; kept in this new file because the neighbouring
// H17 pin files are already large and the (B) stage is a distinct mechanism
// (content baseline for gitignored paths, not the git/index-aware state used
// for pre-dirty tracked paths).
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-baseline-symlink.test.mjs

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

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// See h17-pre-state-snapshot.test.mjs for why this exists (anti-pattern
// ee89c3fd): flattening whitespace, never truncating, keeps a multi-line
// child-process stderr from poisoning the TAP crash/assertion classifier.
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

// Symlink creation can fail on Windows without developer-mode privilege. This
// repo runs under WSL2, where symlinks work — but the probe degrades the
// suite to SKIPPED with a named reason on a host that cannot create them,
// rather than failing (or vacuously passing) there. (P5: a check that cannot
// run says so.)
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

// Build a git-backed project with a live Sterling store + active run, with the
// same gitignored (B) surface h17-pre-state-snapshot.test.mjs's fixture
// carries: .claude/agents/**, .claude/settings.local.json, .sterling/**.
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-symlink-'));
  const runId = 'r-h17sym-' + randomUUID().slice(0, 8);

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
  // Sweep every H17 temp record for this project tag — per-call snapshot
  // records are keyed by sha256(tool_use_id), so their names are not
  // predictable from here and would otherwise leak into /tmp per test.
  const cleanup = (extraPaths = []) => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true });
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

// run h17 in Pre (snapshot) or Post (verify+sweep) mode.
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only, untouched by any of these fixtures
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

// =========================================================================
// PIN-B-SYMLINK-AT-PRE — SYMLINK AT PRE IS A VIOLATION, NOT A FILE TO READ.
// A symlink already sits at a (B) path (.claude/settings.local.json) before
// Pre ever runs, pointing at a file OUTSIDE the repo fixture holding
// recognizable content. collectBaseline's existsSync/statSync/readFileSync
// FOLLOW the link, so today it is read as if it were the settings file's own
// content and snapshotted — no violation is raised, because nothing changes
// across the window (the audited command never touches this path) and the
// followed bytes compare equal to themselves. PHASE: PRE specifically,
// per the settled rule — a non-regular (B) path AT PRE predates the command
// and is an environment defect, so blocking happens before the command ever
// runs, not after. Post is still invoked here only as a defensive
// non-1 check; production never sends a Post for a call Pre denied.
//
// EXPECTED FAILURE SHAPE TODAY (RED): `h17(dir,'PreToolUse',L).code` comes
// back 0 (allow) — the `assert.equal(pre.code, 2, ...)` line fires with
// actual 0.
//
// SABOTAGE (once a fix lands: an lstat-kind guard rejects any (B) path that
// is not a regular file, AT PRE, before any baseline write): delete that
// lstat-kind guard so collectBaseline goes back to reading the path with
// plain existsSync/readFileSync, following whatever sits there. That
// one-line deletion must turn this pin red again.
// =========================================================================

test('PIN-B-SYMLINK-AT-PRE: a symlink planted at a (B) path before Pre is denied AT PRE, not read through', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideTarget = join(tmpdir(), 'sterling-h17-sym-outside-' + randomUUID().slice(0, 8));
  try {
    const outsideContent = Buffer.from('OUTSIDE-REPO CONTENT — must never be read through or written through the link\n');
    writeFileSync(outsideTarget, outsideContent);

    const settingsPath = join(dir, '.claude', 'settings.local.json');
    rmSync(settingsPath, { force: true });
    symlinkSync(outsideTarget, settingsPath);
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true, 'PRECONDITION: the (B) path is a symlink before Pre ever runs');

    const L = lane('symlink-at-pre');
    const pre = h17(dir, 'PreToolUse', L);
    const post = h17(dir, 'PostToolUse', L); // defensive only — see header

    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1 (Pre)');
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
    assert.equal(
      pre.code,
      2,
      `a symlink already sitting at a (B) path before Pre must be denied AT PRE (environment defect, predates the command) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
    );
    assert.deepEqual(readFileSync(outsideTarget), outsideContent, 'the out-of-repo symlink target must be byte-unchanged — the whole point of this pin');
  } finally {
    cleanup([outsideTarget]);
  }
});

// =========================================================================
// PIN-B-SYMLINK-DURING-WINDOW — the SERIOUS half: the restore is a write
// primitive the agent can aim. Baseline is captured normally at Pre from a
// real regular file. Inside the window the audited command deletes that file
// and replaces it with a symlink pointing at an out-of-repo file the agent
// controls. At Post, the followed content differs from the baseline (a real
// change), so the restore path fires: today it writes the baseline bytes to
// the (B) path via a plain write that FOLLOWS the symlink — landing the
// baseline's bytes on a destination fully chosen by the agent, outside the
// repository. PHASE: POST specifically — this is a KIND TRANSITION ACROSS
// THE WINDOW (regular file at Pre, symlink at Post), which the settled rule
// treats as CONDUCT, judged when the window closes.
//
// EXPECTED FAILURE SHAPE TODAY (RED): `readFileSync(outsideTarget)` comes
// back equal to `baselineContent` (the restore wrote through) rather than to
// `outsideContent` (what the agent's fixture put there) — the
// `assert.deepEqual(readFileSync(outsideTarget), outsideContent, ...)` line
// fires, actual buffer equals baselineContent instead.
//
// SABOTAGE (once fixed: an lstat-kind guard runs immediately before the
// restore write and refuses/denies instead of writing when the (B) path is
// not a regular file): delete that pre-write lstat-kind guard so the restore
// goes back to writing through whatever sits at the path. That one-line
// deletion must turn this pin red again.
// =========================================================================

test('PIN-B-SYMLINK-DURING-WINDOW: a (B) path swapped for a symlink mid-window is not written through on restore', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideTarget = join(tmpdir(), 'sterling-h17-sym-window-' + randomUUID().slice(0, 8));
  try {
    const outsideContent = Buffer.from('OUTSIDE-REPO CONTENT planted by the agent — must never receive the baseline bytes\n');
    writeFileSync(outsideTarget, outsideContent);

    const settingsPath = join(dir, '.claude', 'settings.local.json');
    const baselineContent = readFileSync(settingsPath); // the real (B) content Pre will capture

    const L = lane('symlink-window');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of a real regular file succeeds');

    // inside the window: the audited command deletes the real file and
    // re-points the (B) path at an out-of-repo destination the agent chose.
    rmSync(settingsPath, { force: true });
    symlinkSync(outsideTarget, settingsPath);
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true, 'PRECONDITION: the (B) path is now a symlink');
    assert.notDeepEqual(readFileSync(outsideTarget), baselineContent, 'PRECONDITION: the target holds different bytes than the baseline, so a write-through is observable');

    const post = h17(dir, 'PostToolUse', L);

    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `a (B) path swapped for a symlink mid-window must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    assert.deepEqual(readFileSync(outsideTarget), outsideContent, 'the out-of-repo target must be byte-unchanged — a write-through would leave it holding the BASELINE bytes instead');
  } finally {
    cleanup([outsideTarget]);
  }
});

// =========================================================================
// PIN-B-SYMLINKED-DIRECTORY — a symlink placed inside .claude/agents/**
// pointing at a directory OUTSIDE the repo must not cause that directory to
// be walked. We cannot observe the recursive walk itself from outside the
// hook process (no source read, per H4) — only its consequence, which is
// what this pin asserts: no file outside the repo is created or modified,
// and the linked-to directory's membership does not change. If the walk
// happened but produced no out-of-repo write and no membership change, this
// pin cannot distinguish that from "the walk did not happen" — that
// limitation is disclosed here rather than asserted around. PHASE: PRE
// specifically — a symlink already sitting inside .claude/agents/** before
// Pre ever runs is (per the settled rule) an environment defect that
// predates the command, exactly like PIN-B-SYMLINK-AT-PRE, just recursive.
//
// EXPECTED FAILURE SHAPE TODAY (RED): `h17(dir,'PreToolUse',L).code` comes
// back 0 (allow) — the `assert.equal(pre.code, 2, ...)` line fires with
// actual 0. (Today's defect denies nothing here: nothing in this window
// changes the linked-to directory, and a followed baseline compares equal to
// itself at Post regardless — denial is the property being pinned,
// independent of drift.)
//
// SABOTAGE (once fixed: the recursive walk under .claude/agents/** applies
// the same lstat-kind guard to each entry and refuses/denies AT PRE on a
// non-regular, non-directory-owned-by-the-repo entry instead of recursing
// into it): delete that per-entry guard from the walk so a symlinked
// directory entry is read via a plain readdirSync/lstat pair that follows
// it. That one-line deletion must turn this pin red again.
// =========================================================================

test('PIN-B-SYMLINKED-DIRECTORY: a symlink under .claude/agents/** pointing at an outside directory is denied AT PRE, not walked', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-sym-dir-'));
  try {
    const secretPath = join(outsideDir, 'secret.txt');
    const secretContent = Buffer.from('OUTSIDE-REPO DIRECTORY CONTENT — must never be enumerated or read\n');
    writeFileSync(secretPath, secretContent);
    const before = readdirSync(outsideDir).sort();

    const evilPath = join(dir, '.claude', 'agents', 'evil');
    symlinkSync(outsideDir, evilPath);
    assert.equal(lstatSync(evilPath).isSymbolicLink(), true, 'PRECONDITION: a symlink now sits inside .claude/agents/, pointing at a directory outside the repo');

    const L = lane('symlink-dir');
    const pre = h17(dir, 'PreToolUse', L);
    const post = h17(dir, 'PostToolUse', L); // defensive only — see header

    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1 (Pre)');
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
    assert.equal(
      pre.code,
      2,
      `a symlinked directory under .claude/agents/ must be denied AT PRE (environment defect, predates the command) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
    );
    assert.deepEqual(readdirSync(outsideDir).sort(), before, 'no file was created inside the linked-to directory');
    assert.deepEqual(readFileSync(secretPath), secretContent, 'the pre-existing file inside the linked-to directory is byte-unchanged');
  } finally {
    cleanup([]);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// =========================================================================
// PIN-B-UTF8-BYTES — BYTES, NOT LOSSY TEXT. The (B) path holds one invalid-
// UTF-8 byte sequence at Pre and a DIFFERENT invalid-UTF-8 byte sequence at
// Post; both decode to the identical U+FFFD replacement text under
// readFileSync(path,'utf8'), so a UTF-8-string comparison sees no change.
//
// EXPECTED FAILURE SHAPE (RED): `h17(dir,'PostToolUse',L).code` comes
// back 0 (allow, since the decoded strings compare equal) — the
// `assert.equal(post.code, 2, ...)` line fires with actual 0.
//
// SABOTAGE: (B) compares a DECODED string instead of the raw bytes — e.g.
// `readFileSync(abs,'utf8')` fed into the comparison instead of the raw
// Buffer/digest. That one-line substitution makes the two sequences compare
// EQUAL, the call ALLOWS, and the exit-code assertion goes red. (This test
// asserts only on observable file bytes and exit codes — nothing about the
// baseline's internal storage representation.)
//
// *** RE-CUT 2026-08-30, AND THE TIMELINE MATTERS. *** This block's final
// assertion — "a detected (B) change is restored to the baseline bytes" — was
// invalidated by 532a4383 Ruling D / fac9a69b, the EARLIER detect-and-deny
// slice, which made (B) changes DETECTED, DENIED and LEFT ON DISK. It was never
// adjudicated then and has been RED at HEAD since; dc616f69's (A) excision only
// brought it to the surface. So it is inverted here to leave-as-written.
// NOTE WHAT DOES NOT CHANGE: the byte-level-comparison property this pin exists
// for is untouched by either ruling, and its verdict carrier was always the
// EXIT CODE (a decoded comparison ALLOWS), never the restore — so the pin loses
// no teeth in the inversion. The comment above about (B) needing lossless bytes
// "because, unlike (A), it RESTORES from them" is now wrong in its reason and
// right in its requirement: (B) still needs the original bytes to COMPARE
// against, it just no longer writes them back.
// =========================================================================

const UTF8_B_PRE = Buffer.from([0xff, 0xfe]);
const UTF8_B_POST = Buffer.from([0xfe, 0xff]);

test('PIN-B-UTF8-BYTES: two different invalid-UTF-8 byte sequences at a (B) path that decode to the same text still count as CHANGED', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.notEqual(UTF8_B_PRE.toString('base64'), UTF8_B_POST.toString('base64'), 'PRECONDITION: the raw bytes differ');
    assert.equal(UTF8_B_PRE.toString('utf8'), UTF8_B_POST.toString('utf8'), 'PRECONDITION: lossy UTF-8 decoding makes them identical — this is the escape (B) must not fall into');

    const settingsPath = join(dir, '.claude', 'settings.local.json');
    writeFileSync(settingsPath, UTF8_B_PRE);

    const L = lane('utf8-b');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of the (B) path succeeds');

    writeFileSync(settingsPath, UTF8_B_POST);

    const post = h17(dir, 'PostToolUse', L);
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `a byte-level change at a (B) path invisible to UTF-8 decoding must still deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    assert.match(oneLine(post.stderr), /settings\.local\.json/, 'and the denial names the (B) path whose raw bytes moved — so the deny is ABOUT this comparison, not an unrelated fail-closed exit');
    // 532a4383 Ruling D: inverted from "restored to the baseline bytes".
    assert.deepEqual(readFileSync(settingsPath), UTF8_B_POST, 'and the (B) bytes are LEFT ON DISK exactly as written — detect-and-deny never restores');
    assert.notDeepEqual(readFileSync(settingsPath), UTF8_B_PRE, 'specifically NOT put back to the Pre-time baseline bytes');
  } finally {
    cleanup();
  }
});

// =========================================================================
// NOT PINNED: "REVERSE SWAP" (a (B) path recorded as a SYMLINK at Pre, found
// as an ordinary REGULAR FILE at Post) — requested by the coordinator for
// symmetry, deliberately left UNWRITTEN because no honest fixture reaches
// it, per the standing rule that an unreachable pin is worse than a missing
// one.
//
// WHY IT IS UNREACHABLE. The settled phase rule (see file header) makes PRE
// deny on sight of ANY non-regular (B) path, unconditionally, before any
// baseline record is written for it. In real operation a PreToolUse denial
// (exit 2) blocks the tool call outright — Claude Code never issues the
// matching PostToolUse for that tool_use_id. So there is no legitimate
// sequence in which a (B) path's recorded Pre-time kind is "symlink" AND
// Post subsequently runs against that record: the only way to reach Post at
// all is for Pre to have seen (and recorded) a REGULAR file.
//
// Two candidate fixtures were considered and rejected as dishonest:
//   1. Regular file at Pre -> command swaps it to a symlink -> command swaps
//      it BACK to a regular file, all inside one window, before Post runs.
//      This technically starts and ends on "regular file", so it exercises
//      NOTHING about symlink handling: H17 only inspects the two
//      checkpoints, never the interior of the window, so Post would simply
//      see an ordinary content change on a regular file at both ends —
//      indistinguishable from a plain edit, and already the TOCTOU residual
//      decision 2422e76a accepts by name (a transient mid-window state is
//      invisible to a two-checkpoint sweep). It does not prove the rule is
//      symmetric; it proves nothing about symlinks at all.
//   2. Absent at Pre -> command creates a symlink -> Post runs. This makes
//      Post's observed kind "symlink", not "regular file", so it is not the
//      requested transition either, and moreover a live symlink AT POST
//      (never resolved back) folds into PIN-B-SYMLINK-DURING-WINDOW's
//      family (a kind mismatch judged as conduct), not a new case.
// Manually invoking the hook's Post handler after a Pre call that returned
// exit 2 (forcing the pairing our test harness *can* technically construct)
// was also rejected: it would pin the behaviour of an invocation sequence
// that cannot occur in production, so a passing or failing assertion there
// would not describe anything the coordinator or a future reader could rely
// on. If a future design changes what Pre records before it denies (e.g. it
// starts persisting a "kind: symlink" record for forensic purposes even
// while denying), this note should be revisited — until then, no pin.
// =========================================================================

// =========================================================================
// PIN-B-NO-RESTORE-ON-TYPE-TRANSITION — after a denial caused by a kind
// transition across the window, the (B) path itself still holds EXACTLY
// what the audited command left there — H17 must not write to it at all
// while its kind is in question, neither by writing through it (that is
// PIN-B-SYMLINK-DURING-WINDOW's concern, the out-of-repo target) nor by
// unlinking and recreating it as a plain file holding baseline bytes (this
// pin's concern, the (B) path's own kind and target). This is the pin that
// stops a future "fix" from restoring through a guard it just passed.
//
// Reuses PIN-B-SYMLINK-DURING-WINDOW's reachable, honest transition (regular
// file at Pre -> symlink at Post — the only kind-transition direction the
// settled phase rule allows to reach Post at all, since the reverse
// direction is blocked at Pre and is not pinned above). It asserts a
// DIFFERENT pair of observables than that pin: not the outside target's
// bytes, but whether the (B) PATH ITSELF — the symlink the audited command
// left behind — survives Post untouched, in both its kind (still a symlink,
// never replaced by a written-out regular file) and its target (still
// pointing at the same place, never re-pointed by a restore).
//
// EXPECTED FAILURE SHAPE TODAY: uncertain by construction (H4 forbids
// reading the hook to find out) and reported as measured, not assumed — two
// shapes are both plausible under an unfixed restore and both are worth
// naming. (a) If today's restore writes through the symlink (as
// PIN-B-SYMLINK-DURING-WINDOW documents), `lstatSync(settingsPath)` and
// `readlinkSync(settingsPath)` may be UNCHANGED even though the outside
// target was clobbered — because a plain write to a symlinked path follows
// the link rather than replacing it, so this pin's own two assertions could
// already be GREEN even while PIN-B-SYMLINK-DURING-WINDOW is RED on the same
// scenario. (b) If instead the restore unlinks the (B) path and recreates it
// fresh (e.g. `rmSync` then `writeFileSync`, a plausible "clean restore"
// idiom), the path stops being a symlink entirely and
// `assert.equal(lstatSync(settingsPath).isSymbolicLink(), true, ...)` fires
// with actual false. Whichever holds, report it as measured — do not adjust
// the assertions to force a particular outcome.
//
// SABOTAGE (once fixed: a kind-transition denial returns before ANY write
// touches the (B) path, whether through the link or by replacing it):
// reintroduce an unconditional "on changed content, write/replace the (B)
// path with baseline bytes" restore call ahead of, or instead of, the
// kind-transition check. That one-line reordering must turn this pin red
// (it would then observe either a re-pointed/replaced link or a lost
// symlink kind).
// =========================================================================

test('PIN-B-NO-RESTORE-ON-TYPE-TRANSITION: a kind-transition denial at a (B) path never touches the path itself', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideTarget = join(tmpdir(), 'sterling-h17-sym-notouch-' + randomUUID().slice(0, 8));
  try {
    const outsideContent = Buffer.from('OUTSIDE-REPO CONTENT — the destination the agent chose\n');
    writeFileSync(outsideTarget, outsideContent);

    const settingsPath = join(dir, '.claude', 'settings.local.json');

    const L = lane('no-restore-on-transition');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of a real regular file succeeds');

    // inside the window: the audited command deletes the real file and
    // re-points the (B) path at an out-of-repo destination — the same
    // reachable transition PIN-B-SYMLINK-DURING-WINDOW uses.
    rmSync(settingsPath, { force: true });
    symlinkSync(outsideTarget, settingsPath);
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true, 'PRECONDITION: the (B) path is now a symlink, left there by the audited command');
    assert.equal(readlinkSync(settingsPath), outsideTarget, 'PRECONDITION: it points at the destination the audited command chose');

    const post = h17(dir, 'PostToolUse', L);

    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `a kind transition at a (B) path must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    assert.equal(
      lstatSync(settingsPath).isSymbolicLink(),
      true,
      'the (B) path itself must still be exactly what the audited command left there — a symlink — never unlinked and rewritten as a plain restored file'
    );
    assert.equal(readlinkSync(settingsPath), outsideTarget, 'and its link target is unchanged — never re-pointed by a restore attempt');
  } finally {
    cleanup([outsideTarget]);
  }
});
