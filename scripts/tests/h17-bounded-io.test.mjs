// H17 BOUNDED-RESOURCE LAYER — SLICE 1 (board 55fcccac).
//
// Spec: board 55fcccac ("H17 UNBOUNDED-WORK ACCIDENTAL FAIL-OPEN"). THE HOLE:
// H17's Pre snapshot + Post sweep read+hash every dirty file (the WHOLE dirty
// set, not just enforcement paths), read every (B) enforcement file,
// recursively walk dirty untracked dirs, and read the temp records + stamp —
// all UNBOUNDED. An OOM or hook-runner TIMEOUT mid-check kills the process ->
// non-2 exit -> the platform treats non-2 as NON-BLOCKING -> the write is
// ALLOWED. A fail-OPEN reachable BY ACCIDENT (a big dirty tree/file), no
// attacker required. A PARKED attempt (per-file/total-bytes/node/depth/spawn
// caps that DENY on exceed) was REVERTED: Codex found MAX_FILE_BYTES 16MiB
// applied to the ENTIRE dirty set means a user with ONE legit >16MiB dirty
// file (build artifact, dataset, video, PDF) gets EVERY subsequent Bash
// command DENIED — a workflow-breaking false-deny, not a pathological-tree
// edge. THE CORRECT DESIGN the board settles on: (1) STREAM-HASH the
// dirty-set reads (constant memory, no size cap, no false-deny on the
// hashing path); (2) cap only the RETAINED-CONTENT (B) baseline sites,
// which are the small enforcement set and safe to cap; (3) opendirSync
// (incremental) instead of readdirSync; (4) cap/size-guard the Post
// temp-record reads (attribution/state/baseline) and readStamp's
// readFileSync+JSON.parse, which must FAIL CLOSED (deny) on an
// oversize/corrupt record rather than crash/hang; (5) cumulative TIME
// bounding for directory-attestation hashing; walk-node/depth/spawn
// structural caps are FINE to keep (they don't have the false-deny
// disqualifier a byte cap on the dirty set has).
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// or CLI source was read to write these pins; every expectation below comes
// from board 55fcccac's text and the harness conventions already established
// in scripts/tests/h17-pre-state-snapshot.test.mjs,
// scripts/tests/h17-percall-attribution.test.mjs and
// scripts/tests/h17-percall-baseline.test.mjs (makeGitProject, per-lane
// tool_use_id via lane(), the (A) state/attribution and (B) baseline
// discovery-by-listing idiom, the CONTROL-ARM-FIRST idiom, oneLine, GIT_SKIP,
// host-capability probes). NOT imported from those files, since none of them
// export anything.
//
// DELIBERATE NON-DUPLICATION: scripts/tests/h17-pre-state-snapshot.test.mjs
// already carries PIN-CORRUPT-RECORD, a small-malformed-JSON fail-closed pin
// for the (A) per-call STATE record. This file does not repeat that shape for
// the STATE record — only its OVERSIZE angle, which is the genuinely new
// slice-1 concern (a SIZE-triggered guard distinct from a PARSE-failure
// guard). The other three record kinds (stamp, attribution, baseline) get
// both CORRUPT and OVERSIZE variants here, since a per-call-keyed,
// non-degraded-mode fail-closed pin does not already exist for them.
//
// OPEN QUESTIONS (disclosed, not resolved here — the board item does not
// name these constants):
//   Q1. The exact byte-size BUDGET that should trip the "oversize record"
//       guard is unspecified. OVERSIZE_RECORD_BYTES (24MiB, chosen to sit
//       comfortably above the 16MiB threshold the disqualified per-file cap
//       used, and comfortably above any plausible size for these small
//       metadata records) is a judgment call, not a spec value. These tests
//       pin only the DENY-SHAPE at that magnitude, never an exact boundary.
//   Q2. A genuinely OOM-inducing record (hundreds of MB to low GB) cannot be
//       safely and portably constructed in this suite without risking a slow
//       or flaky CI run — and constructing one to "prove" the crash-avoidance
//       property risks reproducing the very crash the property exists to
//       avoid. No test here attempts that scale. If the implementation adds
//       an env-var/config override for the record-size budget, a follow-up
//       slice should add a test that sets a tiny override alongside a
//       tiny-but-over-threshold fixture to exercise the fail-fast branch
//       directly, the same escape hatch clause 3's own instructions offer for
//       the structural walk budgets.
//   Q3. Clause 3's walk-node/depth BUDGET constants are equally unspecified.
//       WIDE (20,000 flat entries) and DEEP (host-probed, up to ~500 nested
//       levels) are the largest fixtures judged practical for a fast,
//       portable, non-flaky suite; the exact trip point is not pinned.
//   Q4. Whether H17's "recursively walk dirty untracked dirs" applies to ANY
//       untracked directory (as board 55fcccac's prose states, describing the
//       dirty-set sweep as processing "the WHOLE dirty set, not just
//       enforcement paths") or only to directories inside a scoped subtree is
//       inferred from that prose, not verified against implementation (H4
//       forbids it). The WIDE/DEEP fixtures below are placed OUTSIDE any
//       enforcement/blast-radius scope on that reading. If the walk is
//       actually scope-conditioned, those fixtures may not exercise the
//       intended code path at all — worth checking against the landed
//       implementation.
//   Q5. Some CORRUPT/OVERSIZE sub-cases below may already be GREEN under
//       HEAD's existing fail-closed try/catch handling (AC9's language
//       already covers "a missing/corrupt snapshot record ... DENIES").
//       Where plausible this is called out per-test rather than asserted as
//       fact, since the suite cannot be executed from here to check.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-bounded-io.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
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
  return { code: r.status, signal: r.signal ?? null, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// Anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated
// into an assertion message that is EXPECTED to fail poisons the TAP
// crash/assertion classifier. Flatten whitespace, NEVER truncate.
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

// Host capability probe for the DEEP structural-budget fixture — mirrors the
// MODE_SKIP/SYMLINK_SKIP idiom in h17-pre-state-snapshot.test.mjs: a check
// that cannot run on this host says so (P5), rather than passing vacuously or
// failing with an opaque ENAMETOOLONG deep inside a test.
const DEEP_DIR_TARGET = 500;
const DEEP_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-deepprobe-'));
    const segments = Array.from({ length: DEEP_DIR_TARGET }, () => 'd');
    mkdirSync(join(d, ...segments), { recursive: true });
    rmSync(d, { recursive: true, force: true });
    return false;
  } catch (e) {
    return `nesting ${DEEP_DIR_TARGET} directory levels is not supported on this host (${e.code ?? e.message})`;
  }
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-bio-'));
  const runId = 'r-h17bio-' + randomUUID().slice(0, 8);

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

  // A tracked "large asset" placeholder, committed small — clauses 1 and 4
  // dirty this to 20MB in-fixture rather than committing 20MB to the temp
  // repo up front.
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'big-data.bin'), 'placeholder\n');

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
  const cleanup = () => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
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

function recordName(p) {
  return String(p).split(/[\\/]/).pop() ?? '';
}

// does this temp file carry the (A) per-call STATE record's AC14 filename?
// (string comparison, not RegExp construction from interpolated values — the
// hardened idiom h17-pre-state-snapshot.test.mjs's roster review settled on.)
function isStateRecord(p, { projectTag, runId }) {
  const name = recordName(p);
  const prefix = `sterling-enforce-${projectTag}-${runId}-call-`;
  const suffix = '.json';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const middle = name.slice(prefix.length, name.length - suffix.length);
  return middle.length > 0 && /^[0-9a-f]+$/.test(middle);
}

// the PER-CALL (A) attribution record: any *.dirty.json temp file for this
// project tag. board 489554d4's per-call keying is shipped, so with a usable
// tool_use_id only the per-call file exists (no legacy per-run collision to
// exclude).
function attributionRecords(fx) {
  return tempRecords(fx.projectTag).filter((p) => recordName(p).endsWith('.dirty.json'));
}

// the (B) content baseline: every temp record for this project tag that is
// neither an (A) state record nor the (A) attribution record.
function baselineRecords(fx) {
  return tempRecords(fx.projectTag).filter((p) => !isStateRecord(p, fx) && !recordName(p).endsWith('.dirty.json'));
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; fixtures do the tampering
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

function stampPath(dir) {
  return join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
}

// dc616f69: the incident marker an (A) detection writes eagerly. This fixture
// builds a real `.sterling/` with a live sterling.db, so the latch persists.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}

function bundlePath(dir) {
  return join(dir, 'hooks', 'h3-contract-gate.mjs');
}

function bigAssetPath(dir) {
  return join(dir, 'assets', 'big-data.bin');
}

function preDirtyBundle(dir, bytes) {
  const p = bundlePath(dir);
  writeFileSync(p, bytes);
  return p;
}

// asserts the hook completed (no timeout/signal kill) and never used the
// non-blocking exit 1 — the two failure shapes that would silently ALLOW on
// this platform (P5: fail loud, never silent).
function assertNoFailOpenCrash(r, context) {
  assert.notEqual(r.code, null, `${context}: must not be killed by timeout/signal (a killed process is a non-2, non-blocking exit — the exact fail-open this board item exists to close) — signal: ${r.signal ?? 'n/a'}, stderr: ${oneLine(r.stderr)}`);
  assert.notEqual(r.code, 1, `${context}: a security gate never fails with a non-blocking exit 1 — stderr: ${oneLine(r.stderr)}`);
}

const MIB = 1024 * 1024;
const BIG_FILE_BYTES = 20 * MIB; // > 16MiB — the exact disqualifying threshold from the parked per-file cap fix
const OVERSIZE_RECORD_BYTES = 24 * MIB; // see OPEN QUESTION Q1

function bigBuffer(bytes, fillByte) {
  return Buffer.alloc(bytes, fillByte);
}

const CORRUPT_SMALL = Buffer.from('{ not valid json,,,');

// ===========================================================================
// SECTION 1 — CLAUSE 1 + CLAUSE 4: no size-based false-deny, and large-file
// hash correctness. The ALLOW test is the CONTROL for the DENY test that
// follows it: both share one large (>16MiB) unrelated dirty tracked file,
// present and untouched throughout; the only difference is whether the
// enforcement path itself is genuinely violated. Placing the ALLOW test first
// establishes that the fixture does not deny merely because the big file
// exists — so the DENY test's verdict is attributable to the real violation,
// not to the file's size.
// ===========================================================================

// PIN-BOUNDED-IO-1-ALLOW (board 55fcccac clause 1). A legit dirty TRACKED
// file much larger than 16MiB, present and unchanged across the window,
// alongside an ordinary read-only Bash command, must ALLOW — the disqualifier
// that reverted the previous cap-based fix was exactly a false deny on this
// shape.
//
// EXPECTED (uncertain without executing, disclosed rather than guessed): HEAD
// (post-revert) carries no per-file/dirty-set byte cap at all, so a naive
// unbounded read+hash of a 20MB file should already ALLOW here — this is
// most plausibly GREEN NOW, functioning as a REGRESSION GUARD against the
// disqualified fix reappearing during the streaming refactor. If HEAD in fact
// still throttles/crashes on this shape (e.g. a slow synchronous hash pushing
// past the 30s harness timeout), this test is the one that would catch it,
// RED via assertNoFailOpenCrash's timeout assertion.
//
// SABOTAGE: reintroduce a per-file (or total dirty-set) byte cap that DENIES
// when a dirty file's size exceeds a threshold below 20MB — the exact
// disqualified fix. `assert.equal(r.code, 0, ...)` flips to actual 2.
test('PIN-BOUNDED-IO-1-ALLOW: board 55fcccac clause 1 — a >16MiB dirty tracked file present and unchanged does not, by itself, deny an ordinary Bash command', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const asset = bigAssetPath(dir);
    const bigBytes = bigBuffer(BIG_FILE_BYTES, 0x61); // 20MiB of 'a'
    writeFileSync(asset, bigBytes);
    assert.ok(bigBytes.length > 16 * MIB, 'PRECONDITION: the dirty tracked file exceeds the 16MiB disqualifying threshold');

    const L = lane('bigfile-allow');
    const pre = h17(dir, 'PreToolUse', L);
    assertNoFailOpenCrash(pre, 'Pre with a 20MB dirty tracked file present');
    assert.equal(pre.code, 0, `Pre must succeed with the big file present — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    const r = h17(dir, 'PostToolUse', L);
    assertNoFailOpenCrash(r, 'Post with a 20MB dirty tracked file present, unchanged, ordinary read-only command');
    assert.equal(r.code, 0, `a large legit dirty file must not by itself deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(asset).length, BIG_FILE_BYTES, "the big file's bytes survive untouched");
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-4-DENY (board 55fcccac clause 4). Large-file hash
// correctness: a genuine violating write to an enforcement path is still
// DENIED when a >16MiB unrelated dirty file is present — the streaming
// refactor must not skip or misattribute hashing because of the big
// bystander file. The enforcement path here is CLEAN at Pre and modified
// in-window (the ordinary "clean at Pre, dirty at Post" violation shape,
// decision 4d9b76e8), independent of the big-file machinery.
//
// EXPECTED (GREEN NOW, most plausibly): this is the already-established
// clean-at-Pre-dirty-at-Post deny behaviour; the only NEW thing this pin adds
// is the large bystander file, to guard against the streaming refactor
// accidentally attributing/mis-hashing across files. If the refactor breaks
// that boundary, this is the test that catches it.
//
// SABOTAGE: while streaming, use one shared hash accumulator across every
// dirty file in a call instead of one per path (a plausible "optimization"
// mistake when moving to incremental reads) — the enforcement violation's
// digest gets polluted by the big bystander file's bytes, either producing a
// spurious match (false ALLOW, `assert.equal(r.code, 2)` fires with actual 0)
// or corrupting the big file's own untouched-state check (the final
// `readFileSync(asset)` equality fires).
test('PIN-BOUNDED-IO-4-DENY: board 55fcccac clause 4 — a real violation to an enforcement path still DENIES with a >16MiB unrelated dirty file present, which survives untouched', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const asset = bigAssetPath(dir);
    const bigBytes = bigBuffer(BIG_FILE_BYTES, 0x62); // 20MiB of 'b'
    writeFileSync(asset, bigBytes);

    const bundle = bundlePath(dir);
    const committedBytes = readFileSync(bundle);

    const L = lane('bigfile-deny');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre: bundle clean, big asset dirty and unchanged from here on');

    writeFileSync(bundle, '// tampered in-window, no stamp exists\n'); // the actual violation
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this must be a real fail-closed deny, not an attested allow');

    const r = h17(dir, 'PostToolUse', L);
    assertNoFailOpenCrash(r, 'Post: real enforcement-path violation with a 20MB unrelated dirty file present');
    assert.equal(r.code, 2, `a genuine violation must still deny with a large bystander file present — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(asset).length, BIG_FILE_BYTES, "the unrelated big file's SIZE survives — it was never touched by the restore/deny path");
    assert.deepEqual(readFileSync(asset), bigBytes, "and its BYTES are byte-for-byte untouched — no cross-file hash/attribution bleed");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SECTION 2 — CLAUSE 2: bounded temp-record reads fail closed. CONTROL-A
// (fixture with a pre-dirty (A) enforcement path and a pre-dirty (B) path,
// UNCHANGED across the window, no record tampered) is placed first: it must
// ALLOW, proving the base fixture used by the record-kind tests below does
// not deny on its own — so a DENY in those tests is attributable to the
// tampered record, not to something else in the shared setup.
// ===========================================================================

const B_SETTINGS_BYTES = '{"hooks":"enabled"}\n';

function preDirtyBaseFixture(dir) {
  const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
  writeFileSync(settingsPath(dir), B_SETTINGS_BYTES);
  return bundle;
}

// PIN-BOUNDED-IO-2-CONTROL-A. Baseline for the ATTRIBUTION/STATE/BASELINE
// record tests below.
//
// EXPECTED: GREEN NOW — this is exactly the shipped PIN-ALLOW shape
// (h17-pre-state-snapshot.test.mjs), extended with a pre-dirty (B) path so a
// baseline record also gets written; nothing here is new behaviour.
//
// SABOTAGE: force the per-path state/baseline equality to always-UNEQUAL —
// this control would then itself deny, and every "record corruption caused
// the deny" claim below becomes unfalsifiable (the shared setup denies
// regardless of what is tampered).
test('PIN-BOUNDED-IO-2-CONTROL-A: CONTROL — the shared base fixture (pre-dirty (A) + (B) paths, untouched, no record tampered) ALLOWS', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    preDirtyBaseFixture(dir);
    const L = lane('control-a');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `CONTROL: the untampered base fixture must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-2-STATE-OVERSIZE (board 55fcccac clause 2, "Pre-state
// record"). The (A) per-call STATE record is overwritten with a 24MiB
// garbage file after Pre (isolating this branch — attribution and baseline
// records are left intact, mirroring PIN-NO-RECORD's isolation idiom). Post
// cannot compare, so per AC9 fail-closed it must DENY — and must do so
// without hanging or crashing.
//
// NOTE (Q5): the small-CORRUPT shape for this exact record is already pinned
// by PIN-CORRUPT-RECORD in h17-pre-state-snapshot.test.mjs and is not
// repeated here. This test's OVERSIZE angle is the new ground: a SIZE-based
// guard is a different code path than a PARSE-failure guard, and at 24MiB a
// naive readFileSync+JSON.parse would not itself crash Node (garbage JSON
// fails fast) — so this may ALSO already be GREEN under the existing
// try/catch, in which case it is a regression guard for the streaming
// refactor rather than proof the new size-precheck exists. It cannot prove
// the true OOM-avoidance property at realistic attack scale (Q2).
//
// SABOTAGE: change the missing/corrupt-record branch to `if (!record)
// continue` (skip and treat as not-pre-dirty) instead of denying — the call
// is ALLOWED and `assert.equal(r.code, 2)` fires with actual 0.
test('PIN-BOUNDED-IO-2-STATE-OVERSIZE: board 55fcccac clause 2 — an OVERSIZE (A) per-call STATE record fails closed (deny), never crash/hang', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    preDirtyBaseFixture(dir);
    const L = lane('state-oversize');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const stateRecords = tempRecords(fx.projectTag).filter((p) => isStateRecord(p, fx));
    assert.ok(stateRecords.length >= 1, `PRECONDITION: Pre must write a discoverable (A) per-call STATE record — found: ${tempRecords(fx.projectTag).map(recordName).join(', ') || '(none)'}`);
    for (const p of stateRecords) writeFileSync(p, bigBuffer(OVERSIZE_RECORD_BYTES, 0x2a));

    assert.ok(attributionRecords(fx).length >= 1, 'PRECONDITION: the (A) attribution record is left intact, isolating this branch');
    assert.ok(baselineRecords(fx).length >= 1, 'PRECONDITION: the (B) baseline record is left intact, isolating this branch');

    const r = h17(dir, 'PostToolUse', L);
    assertNoFailOpenCrash(r, 'Post reading an oversize (A) STATE record');
    assert.equal(r.code, 2, `an unverifiable pre-dirty path (oversize state record) must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-2-ATTRIBUTION-{CORRUPT,OVERSIZE} (board 55fcccac clause 2,
// "attribution record"). Unlike the DEGRADED-mode corrupt/missing pins in
// h17-percall-attribution.test.mjs (which fire under an UNUSABLE
// tool_use_id), these use a USABLE tool_use_id and per-call record — ground
// not covered elsewhere. The (A) attribution record is what tells Post
// whether a currently-dirty path was already dirty at THIS call's own Pre; if
// it cannot be read, Post cannot establish coverage for the pre-dirty bundle
// and per AC9 must deny rather than assume clean.
//
// EXPECTED: RED-most-plausible for both — no per-call, usable-tool_use_id
// corrupt/oversize handling for the ATTRIBUTION record specifically is
// pinned anywhere else read for this file's conventions.
//
// SABOTAGE (both): a missing/unreadable attribution record treated as "no
// paths were pre-dirty" instead of "unverifiable, deny" — the bundle's
// pre-dirty coverage is lost, Post falls into the clean-at-Pre branch,
// restores the bundle to HEAD, and ALLOWS. `assert.equal(r.code, 2)` fires
// with actual 0.
for (const [label, bytes] of [
  ['CORRUPT', CORRUPT_SMALL],
  ['OVERSIZE', bigBuffer(OVERSIZE_RECORD_BYTES, 0x2a)],
]) {
  test(`PIN-BOUNDED-IO-2-ATTRIBUTION-${label}: board 55fcccac clause 2 — a ${label} (A) per-call ATTRIBUTION record fails closed (deny), never crash/hang`, { skip: GIT_SKIP }, () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      preDirtyBaseFixture(dir);
      const L = lane(`attribution-${label.toLowerCase()}`);
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);

      const attrRecords = attributionRecords(fx);
      assert.ok(attrRecords.length >= 1, `PRECONDITION: Pre must write a discoverable (A) attribution record — found: ${tempRecords(fx.projectTag).map(recordName).join(', ') || '(none)'}`);
      for (const p of attrRecords) writeFileSync(p, bytes);

      assert.ok(tempRecords(fx.projectTag).filter((p) => isStateRecord(p, fx)).length >= 1, 'PRECONDITION: the (A) state record is left intact, isolating this branch');
      assert.ok(baselineRecords(fx).length >= 1, 'PRECONDITION: the (B) baseline record is left intact, isolating this branch');

      const r = h17(dir, 'PostToolUse', L);
      assertNoFailOpenCrash(r, `Post reading a ${label} (A) attribution record`);
      assert.equal(r.code, 2, `an unreadable attribution record must deny (coverage cannot be established) — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    } finally {
      cleanup();
    }
  });
}

// PIN-BOUNDED-IO-2-BASELINE-{CORRUPT,OVERSIZE} (board 55fcccac clause 2,
// "baseline record"). The per-call (B) baseline is Post's only source of the
// legitimate pre-image for a (B) path; if it cannot be read, Post cannot
// compare and per AC9 must deny.
//
// EXPECTED: RED-most-plausible for both, same reasoning as ATTRIBUTION above
// — no per-call-keyed corrupt/oversize (B) baseline pin exists in the files
// read for this file's conventions (only the run-keyed DEGRADED-LOUD variant
// in h17-percall-baseline.test.mjs).
//
// SABOTAGE (both): treat an unreadable baseline as "path unchanged" instead
// of "unverifiable, deny" — the (B) tamper is silently adopted and the call
// ALLOWS. `assert.equal(r.code, 2)` fires with actual 0.
for (const [label, bytes] of [
  ['CORRUPT', CORRUPT_SMALL],
  ['OVERSIZE', bigBuffer(OVERSIZE_RECORD_BYTES, 0x2a)],
]) {
  test(`PIN-BOUNDED-IO-2-BASELINE-${label}: board 55fcccac clause 2 — a ${label} (B) per-call BASELINE record fails closed (deny), never crash/hang`, { skip: GIT_SKIP }, () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      preDirtyBaseFixture(dir);
      const L = lane(`baseline-${label.toLowerCase()}`);
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);

      const baseRecords = baselineRecords(fx);
      assert.ok(baseRecords.length >= 1, `PRECONDITION: Pre must write a discoverable (B) baseline record — found: ${tempRecords(fx.projectTag).map(recordName).join(', ') || '(none)'}`);
      for (const p of baseRecords) writeFileSync(p, bytes);

      assert.ok(tempRecords(fx.projectTag).filter((p) => isStateRecord(p, fx)).length >= 1, 'PRECONDITION: the (A) state record is left intact, isolating this branch');
      assert.ok(attributionRecords(fx).length >= 1, 'PRECONDITION: the (A) attribution record is left intact, isolating this branch');

      const r = h17(dir, 'PostToolUse', L);
      assertNoFailOpenCrash(r, `Post reading a ${label} (B) baseline record`);
      assert.equal(r.code, 2, `an unreadable baseline record must deny (no legitimate pre-image to compare) — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    } finally {
      cleanup();
    }
  });
}

// PIN-BOUNDED-IO-2-STAMP-CONTROL. Baseline for the STAMP tests: a
// corrupt/oversize stamp lying on disk, IRRELEVANT because the enforcement
// path never changes across the window, must not by itself cause a deny —
// isolating "stamp is unusable AND was actually needed" (treatment, below)
// from "a bad stamp file merely exists somewhere" (which must never matter on
// its own).
//
// EXPECTED: GREEN NOW, most plausibly — an untouched enforcement path allows
// via observation, without ever consulting the stamp (PIN-ALLOW's shipped
// property). If today's Post reads the stamp unconditionally regardless of
// whether it is needed, this control could be the one that goes RED instead
// — which would itself be a finding worth reporting (an unnecessary stamp
// read on the allow path is exactly the kind of unbounded work this board
// item is about).
//
// SABOTAGE: make Post read the stamp unconditionally, before checking whether
// the pre-dirty path is unchanged.
test('PIN-BOUNDED-IO-2-STAMP-CONTROL: CONTROL — a garbage stamp file present but IRRELEVANT (path never dirtied in-window) does not by itself deny', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    mkdirSync(dirname(stampPath(dir)), { recursive: true });
    writeFileSync(stampPath(dir), bigBuffer(OVERSIZE_RECORD_BYTES, 0x2a));
    const L = lane('stamp-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre: bundle clean, never touched');
    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `CONTROL: an unrelated garbage stamp must not deny an untouched path — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-2-STAMP-{CORRUPT,OVERSIZE} (board 55fcccac clause 2,
// "enforcement stamp"). The classic clean-at-Pre, dirty-at-Post shape: a
// corrupt or oversize stamp must FAIL CLOSED and must never crash the
// readFileSync+JSON.parse in readStamp (board 55fcccac names this exact
// function). THE BOUNDED-READ PROPERTY IS THIS PIN'S SUBJECT and is untouched
// by any ruling — a 32MiB or unparseable file handed to a hook must produce a
// deterministic exit 2, not an OOM, a hang, or a non-blocking exit 1.
//
// RE-CUT 2026-08-30 per dc616f69 (the (A) arm stops restoring): the restore
// half of the old verdict is deleted, so "deny + restore" becomes "deny + left
// on disk + latched". Note what this does NOT change: with the (A) stamp
// exemption also deleted (R11), a changed enforcement path denies whether the
// stamp is readable or not — so the EXIT CODE alone can no longer distinguish
// "the bad stamp was handled" from "stamps are ignored". That is fine here and
// deliberately so, because this pin was never about the stamp's VERDICT; it is
// about the READ not blowing up, which `assertNoFailOpenCrash` carries and
// which PIN-BOUNDED-IO-2-STAMP-CONTROL (garbage stamp present, path never
// dirtied -> ALLOW) keeps honest as the opposite-cause arm.
//
// SABOTAGE: make readStamp() read unbounded / without its try-catch — the
// OVERSIZE arm crashes or hangs and `assertNoFailOpenCrash` fires (exit null
// or 1), which is the arm's real verdict carrier. Separately: reintroduce a
// restore on the (A) violation path -> the byte-identity assertion goes RED.
for (const [label, bytes] of [
  ['CORRUPT', CORRUPT_SMALL],
  ['OVERSIZE', bigBuffer(OVERSIZE_RECORD_BYTES, 0x2a)],
]) {
  test(`PIN-BOUNDED-IO-2-STAMP-${label}: board 55fcccac clause 2 — a ${label} enforcement stamp fails closed (deny, left on disk), never crash/hang`, { skip: GIT_SKIP }, () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      const bundle = bundlePath(dir);
      const committedBytes = readFileSync(bundle);
      mkdirSync(dirname(stampPath(dir)), { recursive: true });
      writeFileSync(stampPath(dir), bytes);

      const L = lane(`stamp-${label.toLowerCase()}`);
      assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch stands before this window');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre: bundle clean at Pre');

      const tampered = Buffer.from('// tampered in-window, only a bad stamp exists\n');
      writeFileSync(bundle, tampered);

      const r = h17(dir, 'PostToolUse', L);
      assertNoFailOpenCrash(r, `Post consulting a ${label} enforcement stamp`);
      assert.equal(r.code, 2, `a changed enforcement path with no readable stamp must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      // dc616f69 R11: inverted from "restored to HEAD". The bounded read still
      // completed and the sweep still reached its verdict — the difference is
      // that the verdict no longer writes to the tree.
      assert.deepEqual(readFileSync(bundle), tampered, 'and the changed path is LEFT ON DISK exactly as written — H17 performs no restore');
      assert.notDeepEqual(readFileSync(bundle), committedBytes, 'specifically NOT put back to the committed image');
      assert.equal(existsSync(latchPath(dir)), true, 'and the detection latched — proving the sweep reached its verdict rather than dying inside the oversize read');
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// SECTION 3 — CLAUSE 3: structural budget trips deny loudly. CONTROL is
// placed first: an ordinary, small untracked directory must ALLOW, proving
// the mere presence of SOME untracked directory is not what the WIDE/DEEP
// tests' deny is about — it is specifically the budget being exceeded.
// ===========================================================================

// PIN-BOUNDED-IO-3-CONTROL. A small, ordinary untracked directory (3 files)
// alongside an ordinary read-only Bash command ALLOWS.
//
// EXPECTED: GREEN NOW — an unremarkable untracked directory is not itself a
// violation.
//
// SABOTAGE: make ANY untracked directory trip the structural-budget deny
// unconditionally (e.g. inverting a `>` to `>=` against a budget of 0) — this
// control would then itself deny, and the WIDE/DEEP tests below would be
// unable to distinguish "budget genuinely exceeded" from "any untracked dir
// denies".
test('PIN-BOUNDED-IO-3-CONTROL: CONTROL — a small, ordinary untracked directory does not deny', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const small = join(dir, 'junk-small');
    mkdirSync(small, { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(small, `f${i}.txt`), 'x');

    const L = lane('struct-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `CONTROL: a small untracked directory must not deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-3-WIDE (board 55fcccac clause 3). 20,000 flat entries in one
// untracked directory (which `git status` collapses to a single "??" line,
// per the untracked-directory-collapse behaviour H17's article already
// documents — so H17 itself must walk it to account for/attest its contents;
// see OPEN QUESTION Q4). This is sized for "tens of thousands of entries,
// runtime sane" per the task's own instruction.
//
// EXPECTED FAILURE SHAPE (RED, most plausible): with no walk-NODE budget in
// place today (the parked structural caps were reverted along with the
// disqualified byte cap), the sweep completes an unbounded walk of 20,000
// tiny files (readdirSync materializes the full listing, which the board item
// flags as itself part of the redesign — opendirSync) and, since the audited
// command is read-only and nothing here violates anything, ALLOWS.
// `assert.equal(r.code, 2)` fires with actual 0. If instead the walk hangs
// past the 30s harness timeout, `assertNoFailOpenCrash`'s null-code assertion
// is what fires — which is itself evidence of the exact fail-open risk this
// board item exists to close (a killed process's non-2 exit reads as allow
// on the real platform, even though this harness reports it honestly).
//
// SABOTAGE: remove the walk-node budget check (or set it to Infinity) — the
// deny never fires and this test regresses to the RED shape above even after
// the redesign lands.
test('PIN-BOUNDED-IO-3-WIDE: board 55fcccac clause 3 — a WIDE (20,000-entry) dirty untracked directory trips the walk-node budget and DENIES loudly, never OOM/timeout/non-2', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const wide = join(dir, 'junk-wide');
    mkdirSync(wide, { recursive: true });
    const N = 20_000;
    for (let i = 0; i < N; i++) writeFileSync(join(wide, `f${i}`), '');

    const L = lane('struct-wide');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre with the wide untracked tree present');

    const r = h17(dir, 'PostToolUse', L);
    assertNoFailOpenCrash(r, 'Post walking a 20,000-entry untracked directory');
    assert.equal(r.code, 2, `a walk-node budget must be exceeded and DENY loudly — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /budget|node|limit|too many|exceed/i, `the deny must NAME the budget it tripped, not just deny silently — stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// PIN-BOUNDED-IO-3-DEEP (board 55fcccac clause 3). A single untracked
// directory chain nested DEEP_DIR_TARGET levels deep (one leaf file at the
// bottom) — the DEPTH axis of the same structural budget, distinct from
// WIDE's NODE-COUNT axis. Host-probed (DEEP_SKIP) since deep nesting is not
// portable to every filesystem/OS (see Windows/Linux parity note in Q3).
//
// EXPECTED FAILURE SHAPE (RED, most plausible): same reasoning as WIDE —
// today's unbounded recursive walk most likely completes (500 levels of
// empty dirs is cheap per-level even without a budget) and ALLOWS, so
// `assert.equal(r.code, 2)` fires with actual 0.
//
// SABOTAGE: remove the walk-depth budget check (or set it to Infinity).
test('PIN-BOUNDED-IO-3-DEEP: board 55fcccac clause 3 — a DEEP dirty untracked directory chain trips the walk-depth budget and DENIES loudly, never OOM/timeout/non-2', { skip: GIT_SKIP || DEEP_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const segments = Array.from({ length: DEEP_DIR_TARGET }, () => 'd');
    const deepDir = join(dir, 'junk-deep', ...segments);
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, 'leaf.txt'), 'x');

    const L = lane('struct-deep');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre with the deep untracked chain present');

    const r = h17(dir, 'PostToolUse', L);
    assertNoFailOpenCrash(r, `Post walking a ${DEEP_DIR_TARGET}-level-deep untracked directory chain`);
    assert.equal(r.code, 2, `a walk-depth budget must be exceeded and DENY loudly — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /budget|depth|limit|too deep|exceed/i, `the deny must NAME the budget it tripped, not just deny silently — stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});
