// H17 (B) STAGE — GITIGNORED-BASELINE ANCESTOR-SYMLINK DEFECT, ROUND 2 (board
// 8b53dc84, outside-family security review of the round-1 fix).
//
// THE DEFECT THIS FILE PINS. Round 1 (scripts/tests/h17-baseline-symlink.test.mjs)
// closed the FINAL-COMPONENT symlink hole: a (B) path itself (a file, or the
// directory the caller was about to read/write) is now classified by lstat
// before it is opened. That round missed a narrower but equally serious hole:
// path resolution still FOLLOWS an INTERMEDIATE symlink COMPONENT when the OS
// resolves the rest of a path string — lstat (and Dirent classification)
// refuses to follow only the LAST component of whatever path it is handed.
// Concretely:
//   (a) `.sterling` replaced by a symlink to an outside directory still let
//       `.sterling/config.json` resolve THROUGH it — the round-1 code only
//       ever lstat'd the FULL joined path `.sterling/config.json`, so the
//       intermediate `.sterling` symlink component was silently followed by
//       the OS before that lstat ever ran.
//   (b) `.claude/agents/**` was walked (readdirSync) BEFORE `.claude` itself
//       was classified — an ordering hazard: even a fully lstat-based scan of
//       `.claude/agents`'s own entries is moot if `.claude` itself is a
//       symlink to an outside tree, because the walk's very first
//       readdirSync call already resolved through it.
//   (c) the restore's own write primitive (writeUnder)'s
//       `mkdirSync(dirname(abs), {recursive:true})` creates directories
//       THROUGH an existing symlinked ancestor exactly the same way a plain
//       write does — folds in board 4d7d188d, the identical hazard on the
//       restore-recreate path specifically.
//
// FIX SHAPE PINNED HERE: every path component from the repo root down is
// classified by lstat BEFORE any read, walk, or write reaches it, extending
// the path only after the prior component is confirmed a real directory —
// and a directory is always classified before it is walked or listed. The
// repo root itself is the trust anchor and is never lstat'd.
//
// OUT OF SCOPE (boarded separately, not pinned here): the check/use TOCTOU
// between this classification and the read/write that follows it —
// descriptor-based O_NOFOLLOW I/O is a platform-parity design question
// (Windows included) left for its own slice.
//
// RED-FIRST: PIN-B-ANCESTOR-STERLING-AT-PRE and PIN-B-ANCESTOR-CLAUDE-AT-PRE
// were run and OBSERVED RED against the round-1 code (git-stashed to isolate
// this slice's round-2 fix) before the round-2 fix landed — see the coder's
// report for the measured before/after; both deny directly from
// `collectBaseline`'s own throw, before any git status is ever consulted, so
// they cleanly discriminate round-1 from round-2. PIN-B-ANCESTOR-RESTORE-NO-
// MKDIR-THROUGH is NOT round-2-discriminating — its own header discloses why
// (the pre-existing (A) tracked-write sweep already covers this exact
// scenario, measured GREEN even against round-1 code) — it is kept as a
// general safety/regression pin for the coordinator's explicit ask, with the
// honest attribution spelled out rather than a false red-first claim. None of
// these three are frozen (round-1's h17-baseline-symlink.test.mjs is the
// frozen file); this file may be revised if a future review finds a fixture
// dishonest.
//
// HARNESS is a faithful copy of h17-baseline-symlink.test.mjs's idiom
// (makeGitProject, the Pre/Post invocation shape sharing one tool_use_id per
// lane, oneLine, GIT_SKIP/SYMLINK_SKIP) — NOT imported from that file, since
// it exports nothing; kept in its own file per that file's own precedent (the
// neighbouring H17 pin files are already large, and this is a distinct
// finding — ancestor-component resolution, not final-component classification).
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-baseline-ancestor.test.mjs

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

// Symlink creation can fail on Windows without developer-mode privilege — see
// h17-baseline-symlink.test.mjs for the rationale (P5: a check that cannot
// run says so, rather than failing or vacuously passing).
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

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-ancestor-'));
  const runId = 'r-h17anc-' + randomUUID().slice(0, 8);

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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only, untouched by any of these fixtures
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

function baselineFilePath(dir, projectTag, runId) {
  return join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.json`);
}

// =========================================================================
// PIN-B-ANCESTOR-STERLING-AT-PRE — `.sterling` ITSELF is a symlink to an
// outside directory holding a `config.json` with recognizable content, before
// Pre ever runs. The round-1 fix only ever lstat'd the FULL joined path
// `.sterling/config.json`; the OS's own path resolution follows the
// INTERMEDIATE `.sterling` symlink component regardless, so that lstat call
// (and the readFileSync behind it) landed on the outside file. PHASE: PRE —
// a non-regular ANCESTOR predates the command exactly like a non-regular leaf
// does, so Pre denies on sight, before any baseline write.
//
// EXPECTED FAILURE SHAPE BEFORE THE ROUND-2 FIX (measured, see report):
// `pre.code` came back 0 (allow) and the OUTSIDE-repo `config.json`'s bytes
// were captured into the baseline temp file as `.sterling/config.json`'s own
// content.
// =========================================================================

test(
  'PIN-B-ANCESTOR-STERLING-AT-PRE: `.sterling` replaced by a symlink to an outside directory is denied AT PRE — its config.json is never read through',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, projectTag, runId, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-anc-sterling-'));
    try {
      const outsideConfigContent = Buffer.from('{"OUTSIDE":"REPO CONFIG — must never be read through the .sterling ancestor symlink"}\n');
      writeFileSync(join(outsideDir, 'config.json'), outsideConfigContent);

      const sterlingPath = join(dir, '.sterling');
      rmSync(sterlingPath, { recursive: true, force: true });
      symlinkSync(outsideDir, sterlingPath);
      assert.equal(lstatSync(sterlingPath).isSymbolicLink(), true, 'PRECONDITION: .sterling is a symlink before Pre ever runs');

      const L = lane('ancestor-sterling');
      const pre = h17(dir, 'PreToolUse', L);

      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        2,
        `a symlinked .sterling ANCESTOR must be denied AT PRE (environment defect, predates the command) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      // No partial baseline may exist: collectBaseline must throw BEFORE
      // writeFileSync(baselineFile, ...) is ever reached.
      const bPath = baselineFilePath(dir, projectTag, runId);
      assert.equal(existsSync(bPath), false, 'no baseline snapshot file may exist — the throw must land before any write to it');

      assert.deepEqual(
        readFileSync(join(outsideDir, 'config.json')),
        outsideConfigContent,
        'the out-of-repo directory reached through the .sterling symlink must be byte-unchanged — the whole point of this pin'
      );
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN-B-ANCESTOR-CLAUDE-AT-PRE — `.claude` ITSELF is a symlink to an outside
// directory before Pre ever runs. The round-1 fix walked `.claude/agents`
// straight away, classifying only entries INSIDE it — never `.claude` itself
// — so a symlinked `.claude` let that very first readdirSync resolve through
// it and enumerate the outside tree. A canary file sits in the outside
// directory's `agents/` subtree (mirroring `.claude/agents/`) so a walk-through
// is observable both as a denial failure AND as a content leak. PHASE: PRE.
//
// EXPECTED FAILURE SHAPE BEFORE THE ROUND-2 FIX (measured, see report):
// `pre.code` came back 0 (allow), and the baseline temp file's
// `.claude/agents/canary.md` key held the OUTSIDE tree's canary content.
// =========================================================================

test(
  'PIN-B-ANCESTOR-CLAUDE-AT-PRE: `.claude` replaced by a symlink to an outside directory is denied AT PRE — .claude/agents/** is never walked into it',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, projectTag, runId, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-anc-claude-'));
    try {
      mkdirSync(join(outsideDir, 'agents'), { recursive: true });
      const canaryContent = Buffer.from('OUTSIDE-REPO CANARY — must never be enumerated or read via a symlinked .claude ancestor\n');
      writeFileSync(join(outsideDir, 'agents', 'canary.md'), canaryContent);
      const beforeAgentsListing = readdirSync(join(outsideDir, 'agents')).sort();

      const claudePath = join(dir, '.claude');
      rmSync(claudePath, { recursive: true, force: true });
      symlinkSync(outsideDir, claudePath);
      assert.equal(lstatSync(claudePath).isSymbolicLink(), true, 'PRECONDITION: .claude is a symlink before Pre ever runs');

      const L = lane('ancestor-claude');
      const pre = h17(dir, 'PreToolUse', L);

      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        2,
        `a symlinked .claude ANCESTOR must be denied AT PRE (environment defect, predates the command) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      const bPath = baselineFilePath(dir, projectTag, runId);
      if (existsSync(bPath)) {
        // Extra belt-and-suspenders: even if some future refactor lets a
        // baseline file land despite the deny, the canary must never appear
        // in it under any key.
        const raw = readFileSync(bPath, 'utf8');
        assert.equal(raw.includes(canaryContent.toString('base64')), false, 'the outside canary bytes must never appear in the baseline, base64 or otherwise');
      }

      assert.deepEqual(readdirSync(join(outsideDir, 'agents')).sort(), beforeAgentsListing, 'the outside directory reached through .claude must gain no entries');
      assert.deepEqual(
        readFileSync(join(outsideDir, 'agents', 'canary.md')),
        canaryContent,
        'the outside canary file reached through the .claude symlink must be byte-unchanged'
      );
    } finally {
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

// =========================================================================
// PIN-B-ANCESTOR-RESTORE-NO-MKDIR-THROUGH — the restore path must never
// mkdir/write through a symlinked ancestor (board 4d7d188d, folded into this
// slice). Pre snapshots `.claude/settings.local.json` and `.claude/agents/**`
// normally (a real `.claude` ancestor). Inside the window, the audited
// command deletes `.claude` entirely and replaces it with a symlink to an
// EMPTY outside directory — so recreating the deleted `settings.local.json`
// would, under a naive fix, need `mkdirSync('.claude', {recursive:true})` to
// "just work" through the symlink (a no-op, since the directory already
// resolves) followed by a write landing `settings.local.json` inside the
// outside directory. Deliberately uses `.claude`, NOT `.sterling`: swapping
// `.sterling` would also delete `sterling.db` out from under the live store
// handle this fixture opened, confounding the result with a store-resolution
// failure instead of isolating the ancestor-symlink hazard.
//
// MEASURED, DISCLOSED HONESTLY (not asserted around) — this is NOT a clean
// pin of `writeUnder`'s own ancestor guard in isolation, and it does not
// claim to be. `.claude` is itself enforcement surface, so the moment it
// stops being a real directory it also becomes a new UNTRACKED git entry
// (`?? .claude` — a top-level symlink is never hidden by a trailing-slash
// `.gitignore` pattern, which matches directories only) and the PRE-EXISTING
// (A) tracked-write sweep (`isEnforcementSurface` + `restoreTracked`) removes
// it BEFORE the (B) stage this slice touches is ever reached — `rmSync` on a
// symlink path unlinks the link itself, never following it, so this ALSO
// happens to be safe, just via a different, older mechanism. Measured: this
// exact scenario denies (and touches nothing in the outside directory) even
// against the code from BEFORE this slice's round-2 ancestor-walk fix,
// because (A) already covered it — so it is a general safety/regression pin,
// not evidence that `collectBaseline`'s or `writeUnder`'s NEW ancestor
// classification fired. Both PIN-B-ANCESTOR-STERLING-AT-PRE and
// PIN-B-ANCESTOR-CLAUDE-AT-PRE above are the genuine red-before/green-after
// pins for the round-2 read-side fix, since Pre denies from `collectBaseline`
// alone, before any git status is ever consulted.
//
// `writeUnder`'s OWN ancestor guard (board 4d7d188d) therefore remains
// unreachable via the public hook interface ABSENT A CONCURRENT FILESYSTEM
// RACE between the Post scan and the restore (the boarded TOCTOU item
// 6c1e0890, explicitly out of scope for this slice) — not unreachable in any
// absolute sense: `collectBaseline` is exhaustive over the ENTIRE (B) surface
// every time it runs as `current` at Post, so if any ancestor anywhere in
// that surface is ALREADY a symlink AT THE TIME OF THAT SCAN, its own throw
// fires before the restore loop — which calls `writeUnder` — is ever
// entered. An ancestor that turns into a symlink AFTER that scan completes
// but BEFORE the matching `writeUnder` call runs is exactly the TOCTOU window
// 6c1e0890 tracks, and `writeUnder`'s guard is what would catch it — so it is
// real, load-bearing defense in depth for that race, not merely a
// hypothetical future-refactor safeguard, per the same "an unreachable pin is
// worse than a missing one" principle h17-baseline-symlink.test.mjs's own
// "NOT PINNED: REVERSE SWAP" note applies to a different transition.
//
// UPDATE 2026-08-30 (dc616f69 / 78dc9bd6), and it CHANGES THE ANALYSIS ABOVE
// without changing a single assertion below: the (A) `restoreTracked` this
// comment credits with unlinking the swapped `.claude` symlink IS DELETED, and
// (B) restoration was already gone. So the symlink is no longer removed by
// anything — it is DETECTED, DENIED and LEFT ON DISK, which is what this block
// actually asserts (exit 2 plus an untouched outside directory). The pin stays
// GREEN and stays honest, but read it now as: "no restore path exists to write
// through a linked ancestor, and the denial still fires." It is a safety net
// against a restore arm returning, not a live guard pin.
// =========================================================================

test(
  'PIN-B-ANCESTOR-RESTORE-NO-MKDIR-THROUGH: a deleted (B) file whose ancestor is now a symlink is never recreated through it (safety net, mechanism disclosed above)',
  { skip: GIT_SKIP || SYMLINK_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-anc-restore-'));
    try {
      const beforeOutsideListing = readdirSync(outsideDir).sort();
      assert.deepEqual(beforeOutsideListing, [], 'PRECONDITION: the outside directory starts empty — any entry appearing there proves a write-through');

      const claudePath = join(dir, '.claude');

      const L = lane('ancestor-restore');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot of a real .claude/** succeeds');

      // Inside the window: the audited command deletes the whole .claude
      // directory (settings.local.json + agents/** included) and replaces it
      // with a symlink to an EMPTY outside directory. .sterling (and its
      // sterling.db) is untouched, so store/run resolution at Post stays
      // exactly as it was at Pre.
      rmSync(claudePath, { recursive: true, force: true });
      symlinkSync(outsideDir, claudePath);
      assert.equal(lstatSync(claudePath).isSymbolicLink(), true, 'PRECONDITION: .claude is now a symlink, left there by the audited command');

      const post = h17(dir, 'PostToolUse', L);

      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(post.code, 2, `a (B) restore whose ancestor is now a symlink must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
      assert.deepEqual(
        readdirSync(outsideDir).sort(),
        beforeOutsideListing,
        'the outside directory reached through the symlinked .claude ancestor must gain NO entries — no mkdir, no write, ever landed there, regardless of which guard fired'
      );
    } finally {
      // .claude may be a symlink or already removed at this point (depending
      // on which guard fired) — cleanup's rmSync(dir, {recursive:true}) never
      // follows a link it finds, and the outside dir is removed separately,
      // so nothing outside the fixture leaks either way.
      cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);
