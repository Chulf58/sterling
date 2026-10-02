// H31 — plan lock STATE WRITER pins (spec-only, red-first).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`
// (knowledge_get 96125184-9797-471b-bb18-31194851c3b3) — read whole, not from
// implementation (H4 read wall; scripts/hooks/h31-plan-lock.mjs and
// scripts/plan-lock.mjs do not exist yet at authoring time).
//
// TWO STATE WRITERS, ONE FILE (per the decision): the PostToolUse hook
// (ExitPlanMode approval -> automatic lock) and the manual CLI (`--plan`,
// `--observe`, `--release`, `--show`). Both write the SAME
// .sterling/plan-lock.json shape, so both are pinned together here rather
// than split across two files that would otherwise duplicate every shape
// assertion.
//
// NEITHER scripts/hooks/h31-plan-lock.mjs NOR scripts/plan-lock.mjs exists
// yet. Every pin below therefore fails TODAY with the SAME named, loud error
// (never a bare ENOENT/TypeError) via runH31()/runPlanLockCli()'s existence
// guard — the spec-only adapter pattern scripts/tests written for the R9
// attested-close suites use (packages/store/src/tests/attested-close.test.ts
// callUpdateRecordMetadata()).
//
// Harness idioms copied (not imported):
//   - makeProject() (real SterlingStore at .sterling/sterling.db before
//     spawning a Sterling hook/CLI — "project-root resolution keys on it
//     actually existing", scripts/tests/h1-plugin-root-sites.test.mjs) —
//     copied from scripts/tests/rotation-note-live-dispatches.test.mjs /
//     scripts/tests/h19-dispatch-staging.test.mjs.
//   - spawnSync + JSON stdin for a PostToolUse hook payload: the
//     {hook_event_name, tool_name, tool_input, session_id, cwd} shape mirrors
//     scripts/tests/h19-dispatch-staging.test.mjs's SubagentStart payload
//     convention, applied to PostToolUse per this brief's own spec text.
//
// ASSUMPTIONS made about shapes the decision states only in prose (disclosed
// here AND in the authoring report so the coder can honour or correct them):
//   - the one-shot unresolved marker (.sterling/transient/plan-lock-unresolved.json)
//     is valid JSON containing a human-readable reason string naming the
//     missing/relative planFilePath problem — the exact field name is
//     unknown; pins below search the RAW file text for keywords, never a
//     specific key name.
//   - the previous-lock marker (.sterling/transient/plan-lock-previous.json)
//     is valid JSON whose raw text includes the SUPERSEDED lock's title
//     verbatim.
//   - `--show`'s JSON output carries a top-level string field named `status`
//     with one of UNCHANGED|MODIFIED|MISSING|UNREADABLE — pins assert on the
//     raw stdout text containing `"status":"<VALUE>"` rather than assuming a
//     specific parse shape beyond "valid JSON".
//   - a refusal's remedy text ("--force", "--reason") appears somewhere in
//     combined stdout+stderr — pins do not assume which stream.
//
// MUTATION DISCIPLINE: every pin names the one-line SABOTAGE that must turn
// it red. None is executed here (this author holds no Bash by design).
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H31_HOOK = join(HOOKS, 'h31-plan-lock.mjs');
const PLAN_LOCK_CLI = join(root, 'scripts', 'plan-lock.mjs');
const SPEC_SLUG = 'plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry';

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h31-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function makePlansDir() {
  return mkdtempSync(join(tmpdir(), 'sterling-plans-'));
}

function writePlan(plansDir, name, content) {
  const p = join(plansDir, name);
  writeFileSync(p, content);
  return p;
}

function lockPath(dir) {
  return join(dir, '.sterling', 'plan-lock.json');
}

function readLock(dir) {
  const p = lockPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function transientPath(dir, name) {
  return join(dir, '.sterling', 'transient', name);
}

// Runs the PostToolUse hook. Throws a NAMED error (never a bare spawn
// failure) while scripts/hooks/h31-plan-lock.mjs does not exist yet.
function runH31(dir, payload) {
  if (!existsSync(H31_HOOK)) {
    throw new Error(`scripts/hooks/h31-plan-lock.mjs not found — expected per decision ${SPEC_SLUG} (H31, PostToolUse ExitPlanMode hook)`);
  }
  const r = spawnSync(process.execPath, [H31_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: dir,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Runs the manual CLI writer. Throws a NAMED error while scripts/plan-lock.mjs
// does not exist yet.
function runPlanLockCli(dir, args) {
  if (!existsSync(PLAN_LOCK_CLI)) {
    throw new Error(`scripts/plan-lock.mjs not found — expected per decision ${SPEC_SLUG} (manual CLI writer: --plan/--observe/--release/--show)`);
  }
  const r = spawnSync(process.execPath, [PLAN_LOCK_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function exitPlanModePayload(dir, { plan, planFilePath, sessionId = 's1', toolName = 'ExitPlanMode' } = {}) {
  const toolInput = { plan };
  if (planFilePath !== undefined) toolInput.planFilePath = planFilePath;
  return {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    cwd: dir,
  };
}

function baseLock(over = {}) {
  return {
    schema_version: 1,
    plan_path: over.plan_path ?? join(tmpdir(), 'nonexistent-default.md'),
    title: 'Existing Plan',
    approved_at: '2026-09-06T09:00:00.000Z',
    approved_sha256: 'a'.repeat(64),
    file_sha256_at_approval: 'a'.repeat(64),
    approved_session_id: 's0',
    approved_branch: 'main',
    approved_head: 'deadbeef',
    source: 'exit_plan_mode',
    ...over,
  };
}

function writeLockFile(dir, over = {}) {
  writeFileSync(lockPath(dir), JSON.stringify(baseLock(over)));
}

// =============================================================================
// SECTION H31 — the PostToolUse ExitPlanMode hook. PINS (1)-(6).
// =============================================================================

// -----------------------------------------------------------------------------
// PIN (1): a successful ExitPlanMode approval binds the full lock shape.
// SABOTAGE: derive `title` from planFilePath's basename instead of parsing
// the first `# ` heading line of tool_input.plan -> the title assertion
// below goes red (the basename looks nothing like "My Plan Title").
// -----------------------------------------------------------------------------
test('PIN 1: a successful ExitPlanMode approval writes the full v1 lock shape, verbatim plan_path, correct title/hashes, exit 0, never a deny', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const planText = '# My Plan Title\n\nSome plan body text.\n';
    const planPath = writePlan(plansDir, 'plan-1.md', planText);
    const r = runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath, sessionId: 's1' }));
    assert.equal(r.code, 0, `H31 must never exit non-zero — stderr=${r.stderr}`);
    if (r.stdout.trim()) {
      assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout, if non-empty, must be valid JSON — never a deny');
    }
    const lock = readLock(dir);
    assert.ok(lock, 'lock file written');
    assert.equal(lock.schema_version, 1);
    assert.equal(lock.plan_path, planPath, 'plan_path is verbatim, absolute, never normalized');
    assert.equal(lock.title, 'My Plan Title', 'title parsed from the first `# ` heading line of the approved text');
    assert.equal(lock.approved_sha256, sha256(planText));
    assert.equal(lock.file_sha256_at_approval, sha256(planText));
    assert.equal(lock.source, 'exit_plan_mode');
    assert.equal(lock.approved_session_id, 's1');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (2): the approved text and the on-disk file differ at approval time ->
// text_file_mismatch:true, BOTH hashes recorded distinctly.
// SABOTAGE: always compute file_sha256_at_approval by hashing tool_input.plan
// a second time (instead of reading the actual file bytes at planFilePath) ->
// the file_sha256_at_approval assertion below goes red (it would equal
// approved_sha256 instead of sha256(fileContent)), and text_file_mismatch
// never becomes true.
// -----------------------------------------------------------------------------
test('PIN 2: approved text differing from the on-disk file at approval sets text_file_mismatch:true with both distinct hashes recorded', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const fileContent = '# File Version\n\nOn-disk text, never approved.\n';
    const planText = '# Approved Version\n\nApproved text, different from the file.\n';
    const planPath = writePlan(plansDir, 'plan-2.md', fileContent);
    const r = runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath }));
    assert.equal(r.code, 0, r.stderr);
    const lock = readLock(dir);
    assert.ok(lock, 'lock written even on a text/file mismatch');
    assert.equal(lock.text_file_mismatch, true, 'the mismatch is disclosed on the record');
    assert.equal(lock.approved_sha256, sha256(planText), 'approved_sha256 hashes the APPROVED TEXT');
    assert.equal(lock.file_sha256_at_approval, sha256(fileContent), 'file_sha256_at_approval hashes the ACTUAL FILE BYTES');
    assert.notEqual(lock.approved_sha256, lock.file_sha256_at_approval);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (3a): a non-ExitPlanMode PostToolUse event never touches an existing
// lock — byte-identical afterward.
// SABOTAGE: gate only on tool_input.plan existing, never checking
// tool_name === 'ExitPlanMode' -> the second call overwrites the lock and the
// byte-identity assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN 3a: a PostToolUse event for a DIFFERENT tool never writes or touches an existing lock (byte-identical before/after)', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const planText = '# Seed Plan\n\nbody\n';
    const planPath = writePlan(plansDir, 'seed.md', planText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath })).code, 0);
    const before = readFileSync(lockPath(dir), 'utf8');

    const r = runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath, toolName: 'Read' }));
    assert.equal(r.code, 0, 'H31 never blocks even for a non-matching tool');
    const after = readFileSync(lockPath(dir), 'utf8');
    assert.equal(after, before, 'the lock is byte-identical — a non-ExitPlanMode event never touches it');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (3b): a missing planFilePath never writes a lock; a bounded unresolved
// marker names the reason.
// SABOTAGE: fabricate a fallback plan_path (e.g. cwd + '/plan.md') when
// planFilePath is absent instead of refusing to bind -> readLock(dir) is
// non-null and/or the unresolved-marker assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN 3b: a missing planFilePath writes NO lock and writes a bounded plan-lock-unresolved.json naming the reason', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runH31(dir, exitPlanModePayload(dir, { plan: '# No Path\n\nbody\n' })); // planFilePath omitted
    assert.equal(r.code, 0, 'H31 never blocks even on a binding failure');
    assert.equal(readLock(dir), null, 'no lock written when planFilePath cannot be bound');
    const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
    assert.ok(existsSync(markerPath), 'a bounded unresolved marker is written instead');
    const raw = readFileSync(markerPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'the marker is valid JSON');
    assert.match(raw, /planFilePath|path/i, 'the marker names the missing-path reason');
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// PIN (3c): a RELATIVE planFilePath never writes a lock; unresolved marker
// names the reason.
// SABOTAGE: resolve a relative planFilePath against process.cwd() instead of
// refusing it -> readLock(dir) becomes non-null and the assertions below go
// red.
// -----------------------------------------------------------------------------
test('PIN 3c: a RELATIVE planFilePath writes NO lock and writes a bounded plan-lock-unresolved.json naming the reason', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runH31(dir, exitPlanModePayload(dir, { plan: '# Relative Path\n\nbody\n', planFilePath: 'plans/relative-plan.md' }));
    assert.equal(r.code, 0);
    assert.equal(readLock(dir), null, 'no lock written for a non-absolute planFilePath');
    const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
    assert.ok(existsSync(markerPath));
    const raw = readFileSync(markerPath, 'utf8');
    assert.match(raw, /relative|absolute|planFilePath/i, 'the marker names the non-absolute-path reason');
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// PIN (4): a second approval REPLACES the lock; plan-lock-previous.json names
// the old title.
// SABOTAGE: overwrite plan-lock.json on a second approval without ever
// writing plan-lock-previous.json -> the existsSync assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN 4: a second ExitPlanMode approval replaces the lock and writes plan-lock-previous.json naming the OLD title', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const firstText = '# First Plan\n\nbody one\n';
    const firstPath = writePlan(plansDir, 'first.md', firstText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: firstText, planFilePath: firstPath })).code, 0);
    assert.equal(readLock(dir).title, 'First Plan');

    const secondText = '# Second Plan\n\nbody two\n';
    const secondPath = writePlan(plansDir, 'second.md', secondText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: secondText, planFilePath: secondPath })).code, 0);
    assert.equal(readLock(dir).title, 'Second Plan', 'the lock now reflects the new approval');

    const prevPath = transientPath(dir, 'plan-lock-previous.json');
    assert.ok(existsSync(prevPath), 'a previous-lock disclosure marker is written on supersession');
    assert.match(readFileSync(prevPath, 'utf8'), /First Plan/, 'names the SUPERSEDED (old) title');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (5): atomicity — no `plan-lock.json.*` temp artifact remains after a
// successful write.
// SABOTAGE: write to a temp path then fs.copyFileSync(temp, final) without
// ever fs.unlinkSync(temp) afterward (instead of a same-directory
// temp-write + renameSync, which removes the source) -> a leftover temp
// entry remains and the assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN 5: a successful approval leaves no plan-lock.json.* temp artifact behind (atomic same-dir write)', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const planText = '# Atomic Plan\n\nbody\n';
    const planPath = writePlan(plansDir, 'atomic.md', planText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath })).code, 0);
    const entries = readdirSync(join(dir, '.sterling'));
    const strays = entries.filter((name) => name !== 'plan-lock.json' && name.startsWith('plan-lock.json'));
    assert.deepEqual(strays, [], `no leftover plan-lock.json.* temp files — found: ${JSON.stringify(strays)}`);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (6): a title containing control characters is sanitized and bounded.
// SABOTAGE: store the raw first-`# `-line substring verbatim with no
// sanitization/length bound -> either assertion below goes red (the escape
// character survives, or the length exceeds 200).
// -----------------------------------------------------------------------------
test('PIN 6: a title containing control characters (ESC) is sanitized, and an oversize title is bounded to a sane length', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const evilHeading = `# ${'A'.repeat(250)}\x1b[31mRED`;
    const planText = `${evilHeading}\n\nbody\n`;
    const planPath = writePlan(plansDir, 'evil.md', planText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath })).code, 0);
    const lock = readLock(dir);
    assert.ok(lock, 'lock written despite the hostile title');
    assert.ok(!lock.title.includes('\x1b'), 'no ESC control character survives into the stored title');
    assert.ok(lock.title.length <= 200, `title bounded to a sane length, got ${lock.title.length}`);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (B1): a LOCK WRITE FAILURE (.sterling made read-only, no write
// permission on the directory itself, so the atomic same-dir temp-write +
// rename cannot even create its temp file) with a valid prior lock present ->
// H31 still exits 0, the prior lock's bytes are byte-for-byte unchanged, and
// a bounded unresolved marker naming a non-empty reason is written. The
// marker itself lands in .sterling/transient, which is pre-created and left
// writable (only .sterling's own directory entry is locked down), so a real
// write failure on the LOCK is distinguishable from a write failure on the
// MARKER — this pin is about the former.
// SABOTAGE: swallow the write failure silently with no unresolved marker (or
// attempt to write plan-lock.json in place with O_TRUNC, which — depending on
// platform/fs semantics — could partially truncate the prior lock before
// failing) -> either the marker's existsSync assertion goes red, or the
// byte-unchanged assertion goes red (a partial/truncated write is not
// byte-identical to `before`).
// -----------------------------------------------------------------------------
test(
  'PIN B1: a lock write failure (.sterling read-only) preserves the prior valid lock and writes a bounded unresolved marker; H31 still exits 0',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'chmod 0o555 has no enforcement effect running as root' : false },
  () => {
    const { dir, cleanup } = makeProject();
    const plansDir = makePlansDir();
    const sterlingDir = join(dir, '.sterling');
    try {
      const priorText = '# Prior Valid Plan\n\nbody\n';
      const priorPath = writePlan(plansDir, 'prior.md', priorText);
      assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: priorText, planFilePath: priorPath })).code, 0);
      const before = readFileSync(lockPath(dir), 'utf8');

      // pre-create transient/ (writable) BEFORE locking down .sterling itself,
      // so the marker write is not incidentally blocked by the same fixture.
      mkdirSync(join(sterlingDir, 'transient'), { recursive: true });
      chmodSync(sterlingDir, 0o555);
      try {
        const newText = '# New Attempt During Lockdown\n\nbody\n';
        const newPath = writePlan(plansDir, 'new-attempt.md', newText);
        const r = runH31(dir, exitPlanModePayload(dir, { plan: newText, planFilePath: newPath }));
        assert.equal(r.code, 0, `H31 never exits non-zero even on a write failure — stderr=${r.stderr}`);
        assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'the prior valid lock is byte-unchanged after a failed write attempt');
        const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
        assert.ok(existsSync(markerPath), 'a bounded unresolved marker is written on write failure');
        const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
        assert.equal(typeof parsed.reason, 'string', 'the marker names a reason string');
        assert.ok(parsed.reason.length > 0, 'the reason is non-empty');
      } finally {
        chmodSync(sterlingDir, 0o755);
      }
    } finally {
      cleanup();
      rmSync(plansDir, { recursive: true, force: true });
    }
  }
);

// -----------------------------------------------------------------------------
// PIN (B2a): planFilePath pointing at a DIRECTORY is an unreadable shape.
// SABOTAGE: pass planFilePath straight to a plain readFileSync with no
// stat/isFile guard -> reading a directory throws EISDIR; if H31 lets that
// exception propagate uncaught, the process crashes/exits non-zero and the
// exit-0 assertion below goes red. If instead it swallows the exception AND
// still writes a lock from whatever partial/garbage read occurred, the
// "prior lock unchanged" assertion goes red.
// -----------------------------------------------------------------------------
test('PIN B2a: planFilePath pointing at a DIRECTORY is an unreadable shape — exit 0 (never killed by the harness timeout), prior lock unchanged, unresolved marker written', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const priorText = '# Prior Plan B2a\n\nbody\n';
    const priorPath = writePlan(plansDir, 'prior-b2a.md', priorText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: priorText, planFilePath: priorPath })).code, 0);
    const before = readFileSync(lockPath(dir), 'utf8');

    const dirAsPlan = join(plansDir, 'a-directory-as-plan');
    mkdirSync(dirAsPlan);
    const r = runH31(dir, exitPlanModePayload(dir, { plan: '# Whatever\n\nbody\n', planFilePath: dirAsPlan }));
    assert.notEqual(r.code, null, 'the process exits on its own — a null status means spawnSync killed it on the harness timeout, i.e. it hung');
    assert.equal(r.code, 0, `H31 never exits non-zero — stderr=${r.stderr}`);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'the prior valid lock is untouched by a directory-shaped planFilePath');
    const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
    assert.ok(existsSync(markerPath), 'a bounded unresolved marker is written for the directory shape');
    assert.doesNotThrow(() => JSON.parse(readFileSync(markerPath, 'utf8')), 'the marker is valid JSON');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (B2b): planFilePath pointing at a regular file LARGER THAN 4 MiB is an
// unreadable shape — same three guarantees as B2a. (ASSUMPTION, disclosed in
// the authoring report: the decision text does not itself state a numeric
// size bound; a 4 MiB ceiling is this brief's own explicit requirement, pinned
// as given rather than loosened, since a looser bound would not discriminate
// the "reads the whole file into memory/hash unconditionally" defect this arm
// exists to catch.)
// SABOTAGE: read/hash the file unconditionally with no size guard before any
// bound check -> the oversize file is accepted as a normal plan and a lock is
// written from it, so the "prior lock unchanged" assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN B2b: planFilePath pointing at a file LARGER THAN 4 MiB is an unreadable shape — exit 0 (never killed by the harness timeout), prior lock unchanged, unresolved marker written', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const priorText = '# Prior Plan B2b\n\nbody\n';
    const priorPath = writePlan(plansDir, 'prior-b2b.md', priorText);
    assert.equal(runH31(dir, exitPlanModePayload(dir, { plan: priorText, planFilePath: priorPath })).code, 0);
    const before = readFileSync(lockPath(dir), 'utf8');

    const hugePath = join(plansDir, 'huge.md');
    writeFileSync(hugePath, Buffer.alloc(4 * 1024 * 1024 + 1024, 'a'));
    const r = runH31(dir, exitPlanModePayload(dir, { plan: '# Whatever\n\nbody\n', planFilePath: hugePath }));
    assert.notEqual(r.code, null, 'the process exits on its own — a null status means spawnSync killed it on the harness timeout, i.e. it hung');
    assert.equal(r.code, 0, `H31 never exits non-zero — stderr=${r.stderr}`);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'the prior valid lock is untouched by an oversize planFilePath');
    const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
    assert.ok(existsSync(markerPath), 'a bounded unresolved marker is written for the oversize-file shape');
    assert.doesNotThrow(() => JSON.parse(readFileSync(markerPath, 'utf8')), 'the marker is valid JSON');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (B2c): a FIFO (named pipe) planFilePath is the third unreadable shape
// named by the dispatch brief. SKIPPED — mkfifo is not reachable through
// node's child_process from this authoring seat (no Bash tool access; the
// test-writer role holds no Bash by design). Left as an explicit skipped
// placeholder, per the brief's own instruction, rather than silently omitted.
// -----------------------------------------------------------------------------
test(
  'PIN B2c: a FIFO (named pipe) planFilePath — SKIPPED, mkfifo unavailable to the test-writer seat',
  { skip: 'mkfifo requires a shell/mkfifo binary this authoring seat cannot invoke (no Bash tool); the coder/conductor should add this arm (e.g. via child_process.execFileSync("mkfifo", [path]) where the platform supports it) mirroring B2a/B2b\'s three guarantees' },
  () => {}
);

// -----------------------------------------------------------------------------
// PIN (B3): temp-path discipline + symlink safety on a successful write.
// (a) no stray temp file (named `.tmp-...`, since the temp name is randomized
// and therefore not predictable/pin-able by literal name) is left in
// .sterling after a successful write; (b) a PRE-EXISTING symlink named
// plan-lock.json, pointing at a decoy file, is REPLACED (the rename swaps the
// directory entry) rather than written through — the decoy's bytes survive
// untouched.
// SABOTAGE: write the new content by opening 'plan-lock.json' directly for
// writing (e.g. writeFileSync(lockPath, ...) with no temp-file + rename step)
// instead of a same-directory random temp-write + atomic rename -> because
// plan-lock.json starts as a symlink in this fixture, a direct open-and-write
// follows the link and WRITES THROUGH IT into the decoy file, so the
// decoy-unchanged assertion below goes red. A temp-write implementation that
// forgets to unlink its temp file on success instead fails the
// no-`.tmp-`-stray assertion.
// -----------------------------------------------------------------------------
test('PIN B3: a successful write leaves no `.tmp-` stray file, and REPLACES a pre-existing plan-lock.json symlink rather than writing through it (decoy untouched)', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const decoyPath = join(dir, '.sterling', 'decoy-target.json');
    const decoyContent = 'DECOY CONTENT — must never be overwritten by a write to plan-lock.json';
    writeFileSync(decoyPath, decoyContent);
    symlinkSync(decoyPath, lockPath(dir));
    assert.ok(lstatSync(lockPath(dir)).isSymbolicLink(), 'fixture sanity: plan-lock.json starts as a symlink pointing at the decoy');

    const planText = '# Symlink Safety Plan\n\nbody\n';
    const planPath = writePlan(plansDir, 'symlink-safety.md', planText);
    const r = runH31(dir, exitPlanModePayload(dir, { plan: planText, planFilePath: planPath }));
    assert.equal(r.code, 0, `H31 never exits non-zero — stderr=${r.stderr}`);

    assert.ok(!lstatSync(lockPath(dir)).isSymbolicLink(), 'plan-lock.json is now a REGULAR file — the symlink entry was replaced by rename, never written through');
    const lock = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    assert.equal(lock.title, 'Symlink Safety Plan', 'the real approval content landed in plan-lock.json itself');
    assert.equal(readFileSync(decoyPath, 'utf8'), decoyContent, 'the decoy the symlink pointed at is byte-unchanged — nothing was ever written through the link');

    const entries = readdirSync(join(dir, '.sterling'));
    const strays = entries.filter((name) => name.startsWith('.tmp-'));
    assert.deepEqual(strays, [], `no stray .tmp- file left behind — found: ${JSON.stringify(strays)}`);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// =============================================================================
// SECTION CLI — the manual writer scripts/plan-lock.mjs. PINS (7)-(12).
// =============================================================================

// -----------------------------------------------------------------------------
// PIN (7): `--plan <path>` with no existing lock writes a manual lock with
// nullable provenance.
// SABOTAGE: populate approved_branch/approved_head from the current git state
// for a manual lock instead of leaving them null -> the nullable-provenance
// assertions below go red.
// -----------------------------------------------------------------------------
test('PIN 7: `--plan <path>` with no existing lock writes source:manual, file-hash approved_sha256, nullable provenance, valid JSON stdout', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const content = '# Manual Plan\n\nplan body v1\n';
    const planPath = writePlan(plansDir, 'manual.md', content);
    const r = runPlanLockCli(dir, ['--plan', planPath]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout is valid JSON');
    const lock = readLock(dir);
    assert.ok(lock);
    assert.equal(lock.source, 'manual');
    assert.equal(lock.approved_sha256, sha256(content));
    assert.equal(lock.approved_session_id, null, 'nullable provenance: session');
    assert.equal(lock.approved_branch, null, 'nullable provenance: branch');
    assert.equal(lock.approved_head, null, 'nullable provenance: head');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (8): `--plan` refuses to replace an existing exit_plan_mode lock
// without `--force`; `--force` replaces it.
// SABOTAGE: skip the exit_plan_mode-lock guard entirely for `--plan` (always
// overwrite) -> the exit-2 assertion and the byte-unchanged assertion below
// both go red.
// -----------------------------------------------------------------------------
test('PIN 8: `--plan` over an existing exit_plan_mode lock refuses (exit 2, names --force, unchanged) without --force; --force replaces it', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    writeLockFile(dir, { title: 'Original Plan' });
    const before = readFileSync(lockPath(dir), 'utf8');
    const newContent = '# New Manual Plan\n\nbody\n';
    const newPath = writePlan(plansDir, 'new.md', newContent);

    const refused = runPlanLockCli(dir, ['--plan', newPath]);
    assert.equal(refused.code, 2, 'refuses without --force');
    assert.match(`${refused.stdout}\n${refused.stderr}`, /--force/, 'names the remedy');
    assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'lock unchanged by the refused attempt');

    const forced = runPlanLockCli(dir, ['--plan', newPath, '--force']);
    assert.equal(forced.code, 0, forced.stderr);
    const lock = readLock(dir);
    assert.equal(lock.source, 'manual');
    assert.notEqual(lock.title, 'Original Plan', 'the lock now reflects the forced manual replacement');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (9): `--observe` records observed_* only, NEVER restamps approved_*;
// deleting the file yields observed_status:'missing', observed_sha256:null.
// SABOTAGE: have --observe also refresh approved_sha256 to the current file
// content (a restamp) -> the "approved_* byte-identical" assertion below
// goes red.
// -----------------------------------------------------------------------------
test('PIN 9: `--observe` updates observed_* only (approved_* stays byte-identical); a deleted file reads observed_status:missing, observed_sha256:null', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const v1 = 'v1 content';
    const planPath = writePlan(plansDir, 'observed.md', v1);
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256(v1), file_sha256_at_approval: sha256(v1), source: 'manual' });
    const before = readLock(dir);

    writeFileSync(planPath, 'v2 content');
    const r1 = runPlanLockCli(dir, ['--observe']);
    assert.equal(r1.code, 0, r1.stderr);
    const after1 = readLock(dir);
    assert.equal(after1.observed_sha256, sha256('v2 content'));
    assert.equal(after1.observed_status, 'present');
    assert.match(String(after1.observed_at), /\d{4}-\d{2}-\d{2}T/, 'observed_at looks like a timestamp');
    assert.equal(after1.approved_sha256, before.approved_sha256, 'approved_sha256 never restamped');
    assert.equal(after1.file_sha256_at_approval, before.file_sha256_at_approval, 'file_sha256_at_approval never restamped');

    rmSync(planPath);
    const r2 = runPlanLockCli(dir, ['--observe']);
    assert.equal(r2.code, 0, r2.stderr);
    const after2 = readLock(dir);
    assert.equal(after2.observed_status, 'missing');
    assert.equal(after2.observed_sha256, null);
    assert.equal(after2.approved_sha256, before.approved_sha256, 'still never restamped after the file disappears');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (10): `--release --reason "x"` deletes the lock and discloses the
// reason; `--release` with no `--reason` refuses.
// SABOTAGE: default an empty/placeholder reason instead of refusing when
// --reason is omitted -> the exit-2 assertion below goes red.
// -----------------------------------------------------------------------------
test('PIN 10: `--release --reason` deletes the lock and writes plan-lock-released.json with the reason; `--release` alone refuses (exit 2)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLockFile(dir, {});
    const r = runPlanLockCli(dir, ['--release', '--reason', 'done working']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLock(dir), null, 'the lock is deleted');
    const releasedPath = transientPath(dir, 'plan-lock-released.json');
    assert.ok(existsSync(releasedPath));
    assert.match(readFileSync(releasedPath, 'utf8'), /done working/);

    writeLockFile(dir, {});
    const refused = runPlanLockCli(dir, ['--release']);
    assert.equal(refused.code, 2, '--release without --reason refuses');
    assert.ok(readLock(dir), 'the lock survives the refused call');
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// PIN (11a-d): `--show` reports UNCHANGED / MODIFIED / MISSING / UNREADABLE.
// SABOTAGE (shared, shape): drop one of the four status branches (e.g. treat
// a missing file the same as MODIFIED) -> the corresponding status assertion
// below goes red.
// -----------------------------------------------------------------------------
test('PIN 11a: `--show` reports UNCHANGED when the file is byte-identical to file_sha256_at_approval', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const content = 'stable content';
    const planPath = writePlan(plansDir, 'stable.md', content);
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256(content), file_sha256_at_approval: sha256(content) });
    const r = runPlanLockCli(dir, ['--show']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"status"\s*:\s*"UNCHANGED"/);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

test('PIN 11b: `--show` reports MODIFIED when the file has changed since approval', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const content = 'original content';
    const planPath = writePlan(plansDir, 'edited.md', content);
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256(content), file_sha256_at_approval: sha256(content) });
    writeFileSync(planPath, 'edited content');
    const r = runPlanLockCli(dir, ['--show']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"status"\s*:\s*"MODIFIED"/);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

test('PIN 11c: `--show` reports MISSING when the plan file no longer exists', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const planPath = join(plansDir, 'gone.md');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x') });
    const r = runPlanLockCli(dir, ['--show']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"status"\s*:\s*"MISSING"/);
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

test(
  'PIN 11d: `--show` reports UNREADABLE when the plan file exists but cannot be read',
  { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) ? 'chmod 000 is not a reliable unreadable-file signal on win32 or as root' : false },
  () => {
    const { dir, cleanup } = makeProject();
    const plansDir = makePlansDir();
    try {
      const content = 'unreadable content';
      const planPath = writePlan(plansDir, 'locked.md', content);
      writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256(content), file_sha256_at_approval: sha256(content) });
      chmodSync(planPath, 0o000);
      const r = runPlanLockCli(dir, ['--show']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /"status"\s*:\s*"UNREADABLE"/);
    } finally {
      chmodSync(join(plansDir), 0o755);
      cleanup();
      rmSync(plansDir, { recursive: true, force: true });
    }
  }
);

// -----------------------------------------------------------------------------
// PIN (11e), THE KEY INVARIANT: `--show`'s live-status comparison uses
// file_sha256_at_approval, NEVER approved_sha256 — a text/file-mismatch lock
// whose file itself is unedited must read UNCHANGED, not MODIFIED.
// SABOTAGE: compare the current file's hash against approved_sha256 instead
// of file_sha256_at_approval -> this test's status assertion goes red (it
// would read MODIFIED, since approved_sha256 deliberately differs from the
// file's real bytes in this fixture).
// -----------------------------------------------------------------------------
test('PIN 11e: a text/file-mismatch lock reads UNCHANGED when the file itself is unedited — comparison is against file_sha256_at_approval, never approved_sha256', () => {
  const { dir, cleanup } = makeProject();
  const plansDir = makePlansDir();
  try {
    const fileBytes = 'file bytes at approval, never edited since';
    const planPath = writePlan(plansDir, 'mismatch.md', fileBytes);
    writeLockFile(dir, {
      plan_path: planPath,
      approved_sha256: sha256('a completely different approved text — from tool_input.plan'),
      file_sha256_at_approval: sha256(fileBytes),
      text_file_mismatch: true,
    });
    const r = runPlanLockCli(dir, ['--show']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"status"\s*:\s*"UNCHANGED"/, 'the file itself was never edited — must read UNCHANGED, not MODIFIED');
  } finally {
    cleanup();
    rmSync(plansDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// PIN (12): outside a Sterling project, every verb refuses (exit 2).
// SABOTAGE: skip the Sterling-project existence check and attempt to operate
// directly on a nonexistent .sterling path -> the exit-2 assertion below
// goes red (crash or unexpected success instead).
// -----------------------------------------------------------------------------
test('PIN 12: outside a Sterling project (no .sterling directory), the CLI refuses with exit 2', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h31-bare-'));
  try {
    const r = runPlanLockCli(bare, ['--show']);
    assert.equal(r.code, 2, 'refuses outside a Sterling project');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
