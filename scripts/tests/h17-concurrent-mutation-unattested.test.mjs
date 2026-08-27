// H17 CONCURRENT-MUTATION / `file_unattested` — THE LIVE-APPENDER FIXTURE
// (board fabf21d8, and the two `sameState` marker guards at
// scripts/hooks/h17-bash-write-sweep.mjs :1591 and :1600).
//
// WHY THIS FILE EXISTS AT ALL — it is the ONLY honest pin for three claims.
//
//   The sibling pin `B` in scripts/tests/h17-baseline-integrity-redo.test.mjs
//   hand-crafts a `file_unattested` marker into the RECORDED side of the state
//   record and asserts Post denies. That pin is PARTIALLY HOLLOW and its own
//   header says so: the CURRENT side is recomputed live and comes back with a
//   REAL digest, so even with BOTH `sameState` marker guards stripped the
//   comparison is `undefined === '<sha>'` — false — and the hook denies anyway.
//   It passes for the WRONG REASON.
//
//   The laundering the marker actually prevents needs BOTH SIDES UNATTESTED:
//   `undefined === undefined` reads as "unchanged" and the hook ALLOWS a file
//   that was rewritten inside the window. The CURRENT side cannot be crafted by
//   hand — only the hook writes it — so the only way to produce that state is
//   to keep the file genuinely unstable across BOTH checkpoints. That is what
//   the detached appender below does.
//
//   The same fixture is also the only honest pin for the FALSE-DENY FIX ITSELF
//   (board fabf21d8): while a dirty file is being actively appended by another
//   legitimate process, the PRE checkpoint must exit 0. Before the fix,
//   sha256OfFileStreamed rejected any size/mtime/ctime movement between its two
//   fstats and the throw escaped to the Pre deny — a command denied for a
//   mutation the still-unexecuted command could not have caused.
//
// WHICH BINARY THIS SPAWNS: the SOURCE hook, `scripts/hooks/h17-bash-write-sweep.mjs`
// (see HOOKS below) — never the esbuild-bundled `hooks/` copy. A stale bundle
// cannot explain a failure here; equally, a green here says nothing about the
// bundle that is actually installed on a machine.
//
// HOW THE RACE IS MADE DETERMINISTIC RATHER THAN LUCKY. A test that merely
// hopes the appender overlapped the snapshot would report a lost race as a
// GREEN pin, which is the exact failure mode this file was written to close.
// So the fixture has THREE LOUD-SKIP GATES, and a verdict is only asserted once
// all three hold:
//   GATE 1  the writer is observed to have grown the file by several chunks
//           BEFORE Pre is spawned — the appender is proven live, not assumed.
//   GATE 2  the Pre-side state record for the target path LITERALLY CARRIES
//           `file_unattested` (and carries no sha256) — the snapshot is proven
//           to have raced, not assumed.
//   GATE 3  the file is observed to have GROWN ACROSS THE POST WINDOW — proving
//           the CURRENT side was recomputed while the file was still unstable,
//           which is what makes both sides unattested. Without this gate a
//           writer that died after Pre would produce the sibling pin's hollow
//           `undefined === '<sha>'` case and the deny below would mean nothing.
// Each gate SKIPS LOUDLY with the observed state. A lost race must never read
// as a passing pin.
// The window itself is widened by construction, not by timing luck: the target
// is pre-dirtied to 8 MiB (so the hook's streamed hash spans tens of
// milliseconds) while the writer appends every few milliseconds — so several
// appends land inside every fstat/hash/fstat bracket.
//
// Authored BLIND to the hook source per H4 — no implementation file was read.
// The line references above come from the dispatch brief and board fabf21d8.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-concurrent-mutation-unattested.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

// The repo-relative path under test. `hooks/hooks.json` is used because the
// sibling suite already demonstrates that a pre-dirty `hooks/hooks.json` lands
// in the (A) per-call state record as `{type:'file', sha256:…}` — so a skip
// here can never be "the path was not recorded at all".
const TARGET_REL = 'hooks/hooks.json';

const BASE_BYTES = 8 * 1024 * 1024; // widens the hook's hash window to tens of ms
const CHUNK_BYTES = 16 * 1024;
const APPEND_INTERVAL_MS = 4;
const WRITER_DEADLINE_MS = 60_000; // hard self-terminate: no orphan on a crashed test
const WRITER_START_TIMEOUT_MS = 8_000;

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// a FAILING assertion message poisons the TAP crash/assertion classifier, so a
// red pin reads as a CRASH. Flatten whitespace, NEVER truncate.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic synchronous sleep — no busy-wait, no timer jitter in the
// polling gates below.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 30_000 });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
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
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['**/*.test.mjs', 'tests/**'], run_commands: { test: 'node --test' } }],
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
    blast_radius: { files: [{ path: 'src/feature.ts', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: ['src/types.ts'],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available';
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function porcelain(dir) {
  return git(dir, ['status', '--porcelain'])
    .stdout.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-appender-'));
  const runId = 'r-h17app-' + randomUUID().slice(0, 8);
  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Appender'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });
  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');
  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
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
  const cleanup = () => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
  };
  return { dir, store, runId, projectTag, cleanup };
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

// The (A) per-call STATE record, found BY SHAPE and never by filename: keys are
// dirty repo-relative paths, values are state OBJECTS carrying `exists`. The
// (B) content baseline is excluded by that test (its values are strings).
// Preserve the by-shape discipline — the record key has been changed once
// already (board 11609d1f), and a filename-shaped finder turns a re-key into a
// silently PASSING test that finds nothing to inspect.
function stateRecord(projectTag) {
  for (const p of tempRecords(projectTag)) {
    let v;
    try {
      v = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => v[k] && typeof v[k] === 'object' && 'exists' in v[k])) return p;
  }
  return null;
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' },
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

// The detached writer. It is a SEPARATE PROCESS — the whole point is that the
// mutation is caused by another legitimate process, exactly as board fabf21d8
// describes, and not by anything the hook could attribute to the audited
// command. Its source lives here as a string so that nothing is ever written
// INSIDE the fixture repo (a writer script in the tree would be one more dirty
// path and would muddy every verdict below). Parameters travel by environment,
// never by argv, because `node -e` argv indexing is version-sensitive.
const WRITER_SRC = `
const fs = require('node:fs');
const target = process.env.H17_TARGET;
const sentinel = process.env.H17_SENTINEL;
const chunk = Buffer.alloc(Number(process.env.H17_CHUNK), 0x61);
const interval = Number(process.env.H17_INTERVAL);
const deadline = Date.now() + Number(process.env.H17_DEADLINE);
function tick() {
  if (Date.now() > deadline) process.exit(0);
  try { if (fs.existsSync(sentinel)) process.exit(0); } catch {}
  try { fs.appendFileSync(target, chunk); } catch { process.exit(0); }
  setTimeout(tick, interval);
}
tick();
`;

function startAppender(targetAbs, sentinelAbs) {
  const child = spawn(process.execPath, ['-e', WRITER_SRC], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      H17_TARGET: targetAbs,
      H17_SENTINEL: sentinelAbs,
      H17_CHUNK: String(CHUNK_BYTES),
      H17_INTERVAL: String(APPEND_INTERVAL_MS),
      H17_DEADLINE: String(WRITER_DEADLINE_MS),
    },
  });
  child.unref();
  return child;
}

function stopAppender(child, sentinelAbs) {
  try {
    writeFileSync(sentinelAbs, 'stop');
  } catch {}
  try {
    child.kill('SIGKILL');
  } catch {}
  // Give the kill a moment to land before the fixture tree is removed, so the
  // writer can never recreate a path underneath rmSync.
  sleepSync(120);
  try {
    rmSync(sentinelAbs, { force: true });
  } catch {}
}

function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

function loudSkip(t, reason) {
  const banner = `\n#### H17 LIVE-APPENDER FIXTURE SKIPPED — NOT A PASS ####\n${reason}\n#######################################################\n`;
  console.error(banner);
  t.diagnostic(oneLine(reason));
  t.skip(oneLine(reason));
}

// =========================================================================
// CONTROL (placed FIRST, must pass for the OPPOSITE reason to the treatment).
//
// The identical fixture — the identical 8 MiB pre-dirtied `hooks/hooks.json`,
// the identical lane, the identical command — with NO WRITER RUNNING must be
// ALLOWED at BOTH checkpoints.
//
// This arm removes three otherwise-live alternative causes for the treatment's
// denial, any one of which would make that denial evidence of nothing:
//   * "a large pre-dirty file denies";
//   * "a pre-dirty `hooks/hooks.json` whose contents are not valid JSON denies"
//     (the filler written here is plain bytes, byte-for-byte the same shape the
//     treatment uses, precisely so this arm fires first if that is the cause);
//   * "this fixture's command/lane denies at Post regardless".
//
// SABOTAGE (must make THIS go RED while the treatment stays green): make the
// (A) comparison deny unconditionally, or refuse any oversize/non-JSON dirty
// enforcement path at Pre.
// =========================================================================
test('CONTROL: an 8 MiB pre-dirty enforcement file that NOBODY is writing is ALLOWED at both checkpoints', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const target = join(fx.dir, ...TARGET_REL.split('/'));
    writeFileSync(target, Buffer.alloc(BASE_BYTES, 0x61));

    const L = lane('appender-control');

    const pre = h17(fx.dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 0, `CONTROL: a large, quiescent, pre-dirty file must not deny at Pre — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    const post = h17(fx.dir, 'PostToolUse', L);
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      post.code,
      0,
      `CONTROL: and nothing changed inside the window, so Post must ALLOW. If this arm is red, the treatment arm below proves nothing — its denial would have this fixture, not the live appender, as its cause. Actual ${post.code}, stderr: ${oneLine(post.stderr)}`
    );
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// TREATMENT ARM 1 — THE FALSE-DENY FIX (board fabf21d8).
//
// A dirty regular file being actively appended by ANOTHER legitimate process
// while H17 takes its Pre snapshot must NOT deny the guarded command. At Pre
// the mutation cannot have been caused by the still-unexecuted command, so
// "violation signal" is too strong: the correct behaviour is to record an
// explicit unattested state and ALLOW.
//
// SABOTAGE (must make this go RED): remove the bounded stability retry +
// `file_unattested` fallback from sha256OfFileStreamed, restoring "reject ANY
// size/mtime/ctime movement between the two fstats" — the throw is not a
// WalkBudgetError, it escapes the per-path catch, and Pre denies with exit 2.
// (This is the pre-fix behaviour the board measured, so this assertion is the
// regression pin for the fix itself.)
//
// The two GATES in this test are loud SKIPS, never passes: a lost race must not
// be reportable as a green pin.
// =========================================================================
test('LIVE APPENDER: a file being written by another process across the Pre snapshot is ALLOWED at Pre and recorded UNATTESTED', { skip: GIT_SKIP }, (t) => {
  const fx = makeGitProject();
  const sentinel = join(tmpdir(), 'sterling-h17-appender-stop-' + randomUUID().slice(0, 8));
  const target = join(fx.dir, ...TARGET_REL.split('/'));
  let writer = null;
  try {
    writeFileSync(target, Buffer.alloc(BASE_BYTES, 0x61));
    writer = startAppender(target, sentinel);

    // ---- GATE 1: prove the writer is LIVE before the hook is spawned ----
    const wantAtLeast = BASE_BYTES + 3 * CHUNK_BYTES;
    const startedAt = Date.now();
    while (sizeOf(target) < wantAtLeast && Date.now() - startedAt < WRITER_START_TIMEOUT_MS) sleepSync(10);
    if (sizeOf(target) < wantAtLeast) {
      loudSkip(
        t,
        `GATE 1 (writer liveness) FAILED: the detached appender never grew ${TARGET_REL} past ${wantAtLeast} bytes within ${WRITER_START_TIMEOUT_MS}ms (observed ${sizeOf(target)}). The RACE WAS NOT ENTERED, so nothing below would be evidence about H17 — this is a fixture/environment problem (spawn blocked, tmpdir full, node -e unavailable), not a verdict on the hook.`
      );
      return;
    }

    const sizeBeforePre = sizeOf(target);
    const L = lane('appender-pre');
    const pre = h17(fx.dir, 'PreToolUse', L);

    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      pre.code,
      0,
      `THE BOARD fabf21d8 PIN. A dirty file being appended by another legitimate process during the Pre snapshot must NOT deny the guarded command — at Pre the mutation cannot have been caused by the still-unexecuted command. Actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
    );
    assert.ok(sizeOf(target) > sizeBeforePre, `evidence: the file kept growing across the Pre window (${sizeBeforePre} -> ${sizeOf(target)})`);

    // ---- GATE 2: prove the Pre snapshot actually RACED ----
    const sPath = stateRecord(fx.projectTag);
    if (!sPath) {
      loudSkip(t, 'GATE 2 (unattested precondition) FAILED: Pre wrote no (A) state record this fixture could find BY SHAPE. Repair the finder — never switch it to a filename.');
      return;
    }
    const raw = readFileSync(sPath, 'utf8');
    const states = JSON.parse(raw);
    const entry = states[TARGET_REL];
    if (!raw.includes('file_unattested') || !entry || entry.file_unattested === undefined) {
      loudSkip(
        t,
        `GATE 2 (unattested precondition) FAILED: the Pre-side state record does NOT literally carry 'file_unattested' for ${TARGET_REL}. The snapshot won the race against an appender it was supposed to lose to, or a different marker (a size/budget cap) was recorded instead. Recorded entry: ${JSON.stringify(entry)}. THIS IS A SKIP, NOT A PASS — the guards this file exists to pin were never exercised.`
      );
      return;
    }
    assert.equal(entry.sha256, undefined, `an unattested state must carry NO digest — a record with both is the contradiction pinned as B-BOTH in the sibling suite. Recorded: ${JSON.stringify(entry)}`);
  } finally {
    if (writer) stopAppender(writer, sentinel);
    fx.cleanup();
  }
});

// =========================================================================
// TREATMENT ARM 2 — THE LAUNDERING PIN. This is the load-bearing test of this
// file and the ONLY honest pin for the two `sameState` marker guards
// (h17-bash-write-sweep.mjs :1591 and :1600).
//
// Both sides are unattested here: the RECORDED side because the Pre snapshot
// raced (GATE 2), the CURRENT side because the file is STILL being appended
// when Post recomputes it (GATE 3). Strip the two marker guards and the
// comparison becomes `undefined === undefined`, which reads as "unchanged" —
// so the hook ALLOWS a file that was rewritten inside the window. That is the
// laundering primitive, and it is invisible to every other test in the suite.
//
// SABOTAGE (must make this go RED): remove BOTH `sameState` marker guards
// (:1591 and :1600) -> Post exits 0 and the exit-code assertion fires.
// DEFENSE-IN-DEPTH NOTE: strip them ONE AT A TIME as well. If the pin stays
// green with only one removed, that is defense in depth and the surviving
// guard is the one carrying the verdict — RECORD WHICH, here, rather than
// assuming both are load-bearing. Only "green with BOTH removed" means hollow.
//
// WHY THE EXIT CODE CAN CARRY THIS VERDICT (unlike the sibling A-DENY pin, where
// it provably cannot): the alternative carrier is git status, and it is ruled
// out by measurement inside the test — the porcelain output is asserted
// IDENTICAL before Pre and after Post (' M hooks/hooks.json' both times, since
// appending to an already-modified tracked file changes bytes, not status). The
// ONLY thing that differs between the checkpoints is file content, which is
// exactly what the state comparison is for. The CONTROL test above rules out
// the fixture itself. The stderr arm then requires the denial to name the path.
// =========================================================================
test('LIVE APPENDER: with BOTH sides unattested, a file rewritten inside the window must NOT launder as "unchanged" — Post DENIES', { skip: GIT_SKIP }, (t) => {
  const fx = makeGitProject();
  const sentinel = join(tmpdir(), 'sterling-h17-appender-stop-' + randomUUID().slice(0, 8));
  const target = join(fx.dir, ...TARGET_REL.split('/'));
  let writer = null;
  try {
    writeFileSync(target, Buffer.alloc(BASE_BYTES, 0x61));
    writer = startAppender(target, sentinel);

    // ---- GATE 1: writer liveness ----
    const wantAtLeast = BASE_BYTES + 3 * CHUNK_BYTES;
    const startedAt = Date.now();
    while (sizeOf(target) < wantAtLeast && Date.now() - startedAt < WRITER_START_TIMEOUT_MS) sleepSync(10);
    if (sizeOf(target) < wantAtLeast) {
      loudSkip(t, `GATE 1 (writer liveness) FAILED: the appender never grew ${TARGET_REL} past ${wantAtLeast} bytes within ${WRITER_START_TIMEOUT_MS}ms (observed ${sizeOf(target)}). The race was not entered — fixture/environment problem, not a verdict.`);
      return;
    }

    const porcelainBefore = porcelain(fx.dir);
    const L = lane('appender-launder');
    const pre = h17(fx.dir, 'PreToolUse', L);
    assert.equal(pre.code, 0, `PRECONDITION (and arm 1's claim): Pre must ALLOW while the file is being appended — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    // ---- GATE 2: the RECORDED side is unattested ----
    const sPath = stateRecord(fx.projectTag);
    if (!sPath) {
      loudSkip(t, 'GATE 2 FAILED: Pre wrote no (A) state record findable BY SHAPE.');
      return;
    }
    const raw = readFileSync(sPath, 'utf8');
    const entry = JSON.parse(raw)[TARGET_REL];
    if (!raw.includes('file_unattested') || !entry || entry.file_unattested === undefined) {
      loudSkip(
        t,
        `GATE 2 FAILED: the Pre-side record does NOT literally carry 'file_unattested' for ${TARGET_REL} (entry: ${JSON.stringify(entry)}). Without an unattested RECORDED side this degenerates into the sibling suite's hollow pin B — 'undefined === <sha>' — and would deny for the wrong reason. SKIP, NOT PASS.`
      );
      return;
    }

    // ---- GATE 3: the CURRENT side must be recomputed while STILL unstable ----
    const sizeBeforePost = sizeOf(target);
    const post = h17(fx.dir, 'PostToolUse', L);
    const sizeAfterPost = sizeOf(target);
    if (!(sizeAfterPost > sizeBeforePost)) {
      loudSkip(
        t,
        `GATE 3 (current-side instability) FAILED: ${TARGET_REL} did not grow across the Post window (${sizeBeforePost} -> ${sizeAfterPost}), so the appender died before Post and the CURRENT side was almost certainly attested with a real digest. A denial from that state is the WRONG-REASON denial this file exists to avoid. SKIP, NOT PASS.`
      );
      return;
    }

    // The alternative carrier, ruled out by measurement rather than by argument.
    assert.deepEqual(
      porcelain(fx.dir),
      porcelainBefore,
      `CARRIER ISOLATION: git's view of the tree must be IDENTICAL at both checkpoints, so that the denial below cannot be produced by H17's git-status arm. Appending to an already-modified tracked file moves bytes, not status. If this fires, the fixture has acquired a second cause and the verdict below must not be believed — before: ${JSON.stringify(porcelainBefore)}, after: ${JSON.stringify(porcelain(fx.dir))}`
    );

    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      post.code,
      2,
      `THE LAUNDERING PIN. Both the recorded and the current state of ${TARGET_REL} are UNATTESTED, and the file was genuinely rewritten inside the window (${sizeBeforePost} -> ${sizeAfterPost} bytes). An unattested state must NEVER compare equal to anything, including another unattested state: 'undefined === undefined' reading as "unchanged" is precisely the laundering the marker was introduced to prevent, and it is the one case no hand-crafted record can reach. If this is 0, the sameState marker guards (:1591/:1600) are not holding. Actual ${post.code}, stderr: ${oneLine(post.stderr)}`
    );
    assert.match(
      post.stderr,
      /hooks[/\\]hooks\.json/,
      `and the denial must name the path it is about — on its own this is not a discriminator, it is here so that a denial concerning some unrelated path cannot satisfy the exit-code arm above. Actual stderr: ${oneLine(post.stderr)}`
    );
  } finally {
    if (writer) stopAppender(writer, sentinel);
    fx.cleanup();
  }
});

// #########################################################################
// NOT PINNED HERE — recorded so the next reader does not infer coverage
// #########################################################################
//
// (1) HASH_STABILITY_ATTEMPTS (h17-bash-write-sweep.mjs :910) REDUCED TO 1.
//     The dispatch brief asked for this fixture to make that mutation go RED.
//     IT DOES NOT, AND I JUDGE IT NOT SOUNDLY PINNABLE FROM OUTSIDE THE
//     PROCESS. Writing a pin that only looks like it covers it would be the
//     hollow-pin failure this whole file exists to correct, so the gap is left
//     visible instead.
//
//     WHY. This fixture's file NEVER stabilizes — the appender runs
//     continuously across both checkpoints by design. Every stability attempt
//     therefore fails whether the budget is 1 or N, the outcome is
//     `file_unattested` either way, and every assertion above stays green under
//     the mutation. The retry budget is only OBSERVABLE on a file that is
//     unstable on the FIRST attempt and stable on a LATER one — i.e. a file
//     that stops mutating at a moment that must fall INSIDE the hook's own
//     retry window.
//
//     WHY THAT CANNOT BE STAGED HONESTLY HERE. The test process cannot observe
//     when the hook takes its first fstat, and the retry budget's wall-clock
//     span is an implementation detail this author may not read (H4). A burst
//     writer timed by guesswork produces one of two failures, both worse than
//     the gap: the burst outlives the budget (the file is marked unattested,
//     the arm fails against a CORRECT implementation — a flaky red in a
//     security suite), or the burst ends before the first attempt (no race
//     happened at all, the arm is green for the wrong reason, and it is green
//     under the mutation too). Worse, those two outcomes are INDISTINGUISHABLE
//     from outside: a successful retry and a race that never occurred both
//     leave exactly one real digest in the record, so not even a loud-skip gate
//     can separate them — which is the property that makes the other three
//     gates in this file sound and this one impossible.
//
//     WHAT A SOUND PIN WOULD NEED (a decision for the conductor, not something
//     a test author should mint — same posture as the PROCFS_FD_DIR seam
//     specified in h17-secure-io-slice1.test.mjs): either the attempt COUNT
//     recorded in the state entry alongside the digest, so a test can assert a
//     retry actually happened; or a test-only environment override for the
//     budget, so a run with the budget forced to 1 can be compared against the
//     same fixture with the shipped budget.
//
// (2) NO-REVERT ON PRE-EXISTING DIRT (decision f76d7c5c) for the appended file.
//     Not asserted: the appender is still writing when the assertions run, so
//     any claim about the file's post-denial contents would be racing the
//     writer. The claim is pinned elsewhere on quiescent fixtures.
// #########################################################################
