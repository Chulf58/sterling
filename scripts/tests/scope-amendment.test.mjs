// Mid-run scope amendment — WRITE PATH + AUDIT + AGENT LOCKOUT (run r-1417, phase p2).
//
// Under test:
//   1. scripts/amend-scope.mjs (NEW) — the conductor CLI that records / refuses
//      scope amendments and shows a run's amendments (interface slice 1,
//      decision fe840f75).  [AC2 record path, AC3 refusal matrix]
//   2. scripts/merge-gate.mjs summary — the no-`--decision` audit view gains
//      scope_amendments alongside check_skipped (interface slice 2).  [AC2 audit]
//   3. scripts/hooks/h14-bash-allowlist.mjs — an agent Bash call to amend-scope.mjs
//      is denied (not allowlisted).  [AC5]
//
// TOOLING NOTE (why AC2-audit + AC5 live here rather than in pipeline.test.mjs /
// enforcement.test.mjs as the brief named): only a whole-file Write was available
// in this session — no in-place edit. Reproducing those 571- / 1389-line frozen
// files verbatim to append a few tests risks a silent transcription drift that
// would WEAKEN an existing frozen oracle (forbidden). Self-contained fixtures in
// this owned file give identical coverage with zero risk to frozen tests. The
// conductor may relocate these two sections when an edit tool is available.
//
// RED DISCIPLINE: amend-scope.mjs does not exist yet (`node <missing>.mjs` exits 1
// with a module-not-found stderr); merge-gate's summary lacks scope_amendments
// today. Every test GUARDS: it asserts the success exit code BEFORE parsing
// stdout, and every refusal matches a REASON keyword the module-not-found error
// never carries — so the pre-impl failure is a clean assertion_fail, not a crash,
// and never a false green.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startRunBranch, phaseCommit } from '../lib/branch-manager.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function amend(dir, args) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'amend-scope.mjs'), ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// A missing CLI's stderr is Node's module-not-found dump, which contains a line
// literally beginning `  code: 'MODULE_NOT_FOUND',`. Interpolated RAW into an
// assertion message, that line lands in the TAP failure diagnostics and the node
// adapter's classifier (parseTap: the first `^\s+code:'…'` decides the outcome)
// reads MODULE_NOT_FOUND before the real ERR_ASSERTION — misreporting a genuine
// assertion_fail as a CRASH (§9.2). Flatten stderr to one line so no diagnostic
// line can begin with `code:`, and the failure classifies as assertion_fail.
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function envelope(type) {
  return {
    id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
  };
}

// in-contract: src/inscope.mjs; out_of_scope: src/legacy/** ; everything else is
// out-of-brief (amendable). Enough surface to exercise the whole refusal matrix.
function amendBrief() {
  return {
    ...envelope('brief'), slug: 'f', title: 'F', problem: 'p', feature: 'f',
    user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src/inscope.mjs', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: [], out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const PHASE = [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }];

// A project with a store + config. `run` (optional) seeds a brief + a run in the
// given machine_state. Returns the live store (read run state back after the CLI
// writes through its own connection — WAL makes committed writes visible).
function makeProject({ run } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-amend-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  let brief, runRec;
  if (run) {
    brief = store.create(amendBrief());
    runRec = store.createRun({
      id: run.id, brief_ref: brief.id, branch: 'b', machine_state: run.machine_state,
      phases: PHASE, dispatch_counts: {}, escalations: [], started_at: NOW,
    });
  }
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, brief, run: runRec, cleanup };
}

// Create a TERMINAL run (merged/rejected). createRun accepts it directly: a
// terminal run is not "active", so the one-active-run guard does not fire, and it
// is only reachable via explicit --run since getRun() (auto) excludes terminals.
function seedTerminalRun(store, id, machine_state) {
  const brief = store.create(amendBrief());
  return store.createRun({
    id, brief_ref: brief.id, branch: 'b', machine_state, phases: PHASE,
    dispatch_counts: {}, escalations: [], started_at: NOW,
  });
}

// ===========================================================================
// SUCCESS PATH — record / duplicate / halted / show (interface slice 1, AC2)
// ===========================================================================

test('amend-scope record: a valid out-of-brief amendment appends {path,reason,at} to the run + prints {amended} (AC2, interface 1)', () => {
  const { dir, store, cleanup } = makeProject({ run: { id: 'r-am', machine_state: 'running' } });
  try {
    const r = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'adjudicated mid-run', '--target', dir]);
    assert.equal(r.code, 0, `a valid out-of-brief amendment must succeed — ${oneLine(r.stderr)}`); // GUARD before parse
    const out = JSON.parse(r.stdout);
    assert.equal(out.amended.path, 'src/other.mjs');
    assert.equal(out.amended.reason, 'adjudicated mid-run');
    assert.equal(typeof out.amended.at, 'string', 'the amendment carries a timestamp');

    const amendments = store.getRun('r-am').scope_amendments;
    assert.equal(amendments.length, 1, 'exactly one amendment sits on the run record');
    assert.equal(amendments[0].path, 'src/other.mjs');
    assert.equal(amendments[0].reason, 'adjudicated mid-run');
    assert.equal(typeof amendments[0].at, 'string');
  } finally {
    cleanup();
  }
});

test('amend-scope record: --run selects the active run implicitly; the same path twice is an idempotent-skip, first {reason,at} stands (interface 1)', () => {
  const { dir, store, cleanup } = makeProject({ run: { id: 'r-dup', machine_state: 'running' } });
  try {
    const first = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'first reason', '--target', dir]);
    assert.equal(first.code, 0, `first amendment must succeed — ${oneLine(first.stderr)}`); // GUARD

    const second = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'second reason', '--target', dir]);
    assert.equal(second.code, 0, `a duplicate path is an idempotent-skip (exit 0), not a refusal — ${oneLine(second.stderr)}`);
    assert.match(second.stdout, /already[- ]amended/i, 'the duplicate is reported as already-amended');

    const amendments = store.getRun('r-dup').scope_amendments;
    assert.equal(amendments.length, 1, 'no duplicate entry is appended');
    assert.equal(amendments[0].reason, 'first reason', 'the FIRST {reason,at} stands (idempotent on path)');
  } finally {
    cleanup();
  }
});

test('amend-scope record: accepts any NON-terminal state — a halted run is amendable (interface 1)', () => {
  const { dir, store, cleanup } = makeProject({ run: { id: 'r-halt', machine_state: 'halted' } });
  try {
    const r = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'adjudicated while halted', '--target', dir]);
    assert.equal(r.code, 0, `halted is non-terminal and must be accepted — ${oneLine(r.stderr)}`); // GUARD
    assert.equal(store.getRun('r-halt').scope_amendments.length, 1);
  } finally {
    cleanup();
  }
});

test('amend-scope show: prints the run scope_amendments (interface 1)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-show', machine_state: 'running' } });
  try {
    assert.equal(amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'shown', '--target', dir]).code, 0); // GUARD
    const r = amend(dir, ['show', '--target', dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /src\/other\.mjs/, 'show lists the amended path');
  } finally {
    cleanup();
  }
});

test('amend-scope show: an unamended run shows an empty amendment set (exit 0)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-empty', machine_state: 'running' } });
  try {
    const r = amend(dir, ['show', '--target', dir]);
    assert.equal(r.code, 0, `show on a clean run succeeds — ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// REFUSAL MATRIX — AC3 (loud refusal on each case) + the usage-fail boundary.
// Every refusal exits non-zero AND names its reason.
// ===========================================================================

test('amend-scope record refuses: missing --path is a usage failure (exit 1, interface 1)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-usage-p', machine_state: 'running' } });
  try {
    const r = amend(dir, ['record', '--reason', 'x', '--target', dir]);
    assert.equal(r.code, 1, 'a usage failure exits 1');
    assert.match(r.stderr, /required|missing|usage|--path/i, 'names the missing --path argument');
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: missing --reason is a usage failure (exit 1, interface 1)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-usage-r', machine_state: 'running' } });
  try {
    const r = amend(dir, ['record', '--path', 'src/other.mjs', '--target', dir]);
    assert.equal(r.code, 1, 'a usage failure exits 1');
    assert.match(r.stderr, /required|missing|usage|--reason/i, 'names the missing --reason argument');
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: no active run (AC3)', () => {
  const { dir, cleanup } = makeProject(); // store, but NO run seeded
  try {
    const r = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'x', '--target', dir]);
    assert.notEqual(r.code, 0, 'must refuse when there is no active run');
    assert.match(r.stderr, /no active run/i, 'names the reason');
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: a glob metachar path (AC3)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-glob', machine_state: 'running' } });
  try {
    for (const bad of ['src/*.mjs', 'src/foo?.mjs', 'src/[abc].mjs', 'src/{a,b}.mjs']) {
      const r = amend(dir, ['record', '--path', bad, '--reason', 'x', '--target', dir]);
      assert.notEqual(r.code, 0, `${bad} must refuse (a glob is not an exact path)`);
      assert.match(r.stderr, /glob|exact|non-exact/i, bad);
    }
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: a non-exact path — absolute / drive-prefixed / parent-escaping (AC3)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-nonexact', machine_state: 'running' } });
  try {
    for (const bad of ['/etc/passwd', 'C:/win.mjs', '../escape.mjs']) {
      const r = amend(dir, ['record', '--path', bad, '--reason', 'x', '--target', dir]);
      assert.notEqual(r.code, 0, `${bad} must refuse (repoPath normalization rejects it)`);
      assert.match(r.stderr, /glob|exact|non-exact|absolute|escape|repo-relative|outside|invalid|normal/i, bad);
    }
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: a path matching the brief out_of_scope (AC3)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-oos', machine_state: 'running' } });
  try {
    const r = amend(dir, ['record', '--path', 'src/legacy/old.mjs', '--reason', 'x', '--target', dir]);
    assert.notEqual(r.code, 0, 'an out_of_scope path can never be amended in');
    assert.match(r.stderr, /out_of_scope/i, 'names the reason');
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: an enforcement-surface path (ENFORCEMENT_SURFACE + hooks/**) (AC3)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-enf', machine_state: 'running' } });
  try {
    // .sterling/config.json + .claude/agents/** + .claude/settings*.json come from contract.mjs
    // ENFORCEMENT_SURFACE; hooks/** from the "plus hooks/**" clause of the interface.
    for (const surface of ['.sterling/config.json', '.claude/agents/coder.md', '.claude/settings.local.json', 'hooks/h3-contract-gate.mjs']) {
      const r = amend(dir, ['record', '--path', surface, '--reason', 'x', '--target', dir]);
      assert.notEqual(r.code, 0, `${surface} is enforcement surface and must refuse`);
      assert.match(r.stderr, /enforcement|self-protection|surface|protected/i, surface);
    }
  } finally {
    cleanup();
  }
});

test('amend-scope record refuses: a terminal-state run reached via explicit --run (AC3)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedTerminalRun(store, 'r-merged', 'merged');
    const r = amend(dir, ['record', '--path', 'src/other.mjs', '--reason', 'x', '--run', 'r-merged', '--target', dir]);
    assert.notEqual(r.code, 0, 'a terminal (merged) run cannot be amended');
    assert.match(r.stderr, /terminal|merged|rejected/i, 'names the terminal state');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// REFUSAL ORDER — the order is load-bearing (decision fe840f75):
// usage → no active run → terminal → glob/non-exact → out_of_scope → enforcement.
// An earlier reason must win over a later one when a path trips both.
// ---------------------------------------------------------------------------

test('amend-scope refusal order: a glob path that ALSO matches out_of_scope refuses as glob, not out_of_scope (interface 1)', () => {
  const { dir, cleanup } = makeProject({ run: { id: 'r-ord-glob', machine_state: 'running' } });
  try {
    // 'src/legacy/*.mjs' is a glob AND matches out_of_scope 'src/legacy/**' — glob check precedes the out_of_scope loop.
    const r = amend(dir, ['record', '--path', 'src/legacy/*.mjs', '--reason', 'x', '--target', dir]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /glob|exact|non-exact/i, 'glob/non-exact refusal precedes out_of_scope');
    assert.doesNotMatch(r.stderr, /out_of_scope/i, 'the out_of_scope loop is never reached for a glob path');
  } finally {
    cleanup();
  }
});

test('amend-scope refusal order: a terminal run + an out_of_scope path refuses as terminal-state, not out_of_scope (interface 1)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedTerminalRun(store, 'r-ord-term', 'rejected');
    // terminal-state (step 3) precedes the out_of_scope check (step 5).
    const r = amend(dir, ['record', '--path', 'src/legacy/old.mjs', '--reason', 'x', '--run', 'r-ord-term', '--target', dir]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /terminal|rejected|merged/i, 'terminal-state refusal precedes out_of_scope');
    assert.doesNotMatch(r.stderr, /out_of_scope/i, 'the out_of_scope check is never reached for a terminal run');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC2 AUDIT — merge-gate's no-`--decision` summary lists every scope_amendment
// alongside check_skipped (interface slice 2). scope_amendments is absent from
// that summary today, so the deepEqual is assertion-red pre-impl.
// ===========================================================================

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// Git-backed project driven to awaiting_merge_gate — the state at which the gate
// summary is viewed. `amendments` seeds the run's scope_amendments.
function makeGateProject({ amendments } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gate-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.createRun({
    id: 'r-gate', brief_ref: randomUUID(), branch: 'pending', machine_state: 'running',
    phases: PHASE, dispatch_counts: {}, escalations: [], started_at: NOW,
    ...(amendments ? { scope_amendments: amendments } : {}),
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { dir, store, cleanup };
}

function driveToGate(dir, store) {
  startRunBranch({ cwd: dir, store, runId: 'r-gate' });
  writeFileSync(join(dir, 'src', 'feature.mjs'), 'export const f = 2;\n');
  phaseCommit({ cwd: dir, store, runId: 'r-gate', phaseId: 'p1' });
  store.casTransition('running', { ...store.getRun('r-gate'), machine_state: 'completing' });
  store.casTransition('completing', { ...store.getRun('r-gate'), machine_state: 'awaiting_merge_gate' });
}

function gateSummary(dir) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'merge-gate.mjs'), '--run', 'r-gate', '--target', dir], {
    encoding: 'utf8', cwd: dir, timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('merge-gate summary lists every scope_amendment alongside check_skipped (AC2)', () => {
  const amendments = [
    { path: 'src/other.mjs', reason: 'adjudicated mid-run', at: NOW },
    { path: 'src/extra.mjs', reason: 'second adjudication', at: NOW },
  ];
  const { dir, store, cleanup } = makeGateProject({ amendments });
  try {
    driveToGate(dir, store);
    const r = gateSummary(dir);
    assert.equal(r.code, 0, `the gate summary must print — ${r.stderr}`); // GUARD before parse
    const summary = JSON.parse(r.stdout);
    assert.ok('check_skipped' in summary, 'scope_amendments prints alongside check_skipped (the audit view)');
    assert.deepEqual(summary.scope_amendments, amendments, 'every amendment on the run appears in the merge-gate summary');
  } finally {
    cleanup();
  }
});

test('merge-gate summary: scope_amendments is an empty array when the run has none (AC2)', () => {
  const { dir, store, cleanup } = makeGateProject(); // no amendments
  try {
    driveToGate(dir, store);
    const r = gateSummary(dir);
    assert.equal(r.code, 0, `the gate summary must print — ${r.stderr}`); // GUARD before parse
    assert.deepEqual(JSON.parse(r.stdout).scope_amendments, [], 'empty array when there are no amendments (run.scope_amendments ?? [])');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC5 — an agent CANNOT invoke the amendment script through Bash: H14 denies it
// (not on the allowlist). This is a LOCKOUT REGRESSION GUARD: H14 already denies
// any non-allowlisted command, so the assertion holds both before and after the
// CLI ships — its value is catching a future erroneous allowlisting of amend-scope
// (the assertion CAN fail: were amend-scope allowlisted, the code would be 0).
// ===========================================================================

const H14_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeHookProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-amend-h14-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H14_CONFIG));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function runH14(dir, command, over = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h14-bash-allowlist.mjs')], {
    input: JSON.stringify({
      session_id: 's1', transcript_path: join(dir, 'transcripts', 's1.jsonl'), cwd: dir,
      permission_mode: 'default', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command }, ...over,
    }),
    encoding: 'utf8', cwd: dir, timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('H14 [AC5]: an agent Bash call to amend-scope.mjs is denied — not on the allowlist', () => {
  const { dir, cleanup } = makeHookProject();
  try {
    const r = runH14(dir, 'node scripts/amend-scope.mjs record --path x --reason y', { agent_id: 'a1' });
    assert.equal(r.code, 2, `an agent must not be able to invoke the amendment script via Bash — ${r.stderr}`);
    assert.match(r.stderr, /not on the allowlist/i, 'the denial names the allowlist (H14)');
  } finally {
    cleanup();
  }
});
