import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runTests, staticWiring } from '../adapters/node.mjs';
import { runTests as pesterRun } from '../adapters/pester.mjs';
import { resolveToolchains, checkAdapterRegistry, loadAdapter } from '../adapters/resolve.mjs';
import { findBackslashCommandsInHooksJson } from '../lib/agent-distribution.mjs';

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

function makeProject({ withRun = false, config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-enf-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  let run;
  let brief;
  if (withRun) {
    brief = store.create({
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
    });
    run = store.createRun({
      id: 'r-1',
      brief_ref: brief.id,
      branch: 'sterling/run-r-1',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
    });
  }
  // physical files so edit-vs-creation is distinguishable
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;');
  writeFileSync(join(dir, 'src', 'types.ts'), 'export type T = 1;');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, run, brief, cleanup };
}

function hookInput(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 'transcripts', 's1.jsonl'),
    cwd: dir,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    ...over,
  };
}

function seedLedger(dir, runId, agentId, paths) {
  const p =
    runId && agentId
      ? join(dir, '.sterling', 'runs', runId, 'reads', `agent-${agentId}.json`)
      : join(dir, '.sterling', 'transient', 'conductor-reads.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(paths.map((path) => ({ agent_id: agentId ?? 'conductor', path, at: NOW }))));
  return p;
}

function writeAgentTranscript(dir, agentId, inputTokens, { withUsage = true } = {}) {
  const t = join(dir, 'transcripts', 's1', 'subagents', `agent-${agentId}.jsonl`);
  mkdirSync(dirname(t), { recursive: true });
  const entries = [
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    JSON.stringify(
      withUsage
        ? {
            type: 'assistant',
            message: {
              model: 'test-model',
              usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
            },
          }
        : { type: 'assistant', message: { model: 'test-model' } }
    ),
  ];
  writeFileSync(t, entries.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// node toolchain adapter (§9.1)
// ---------------------------------------------------------------------------

test('adapter: classifies pass | assertion_fail | crash against real node --test runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-adapter-'));
  try {
    writeFileSync(join(dir, 'p.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; test('ok', () => assert.equal(1,1));");
    writeFileSync(join(dir, 'a.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; test('af', () => assert.equal(1,2));");
    writeFileSync(join(dir, 'c.test.mjs'), "import {test} from 'node:test'; test('boom', () => { throw new Error('boom'); });");
    writeFileSync(join(dir, 's.test.mjs'), "import {test} from 'node:test'; this is not javascript");

    assert.equal(runTests({ cwd: dir, scope: ['p.test.mjs'] }).overall, 'pass');
    const af = runTests({ cwd: dir, scope: ['a.test.mjs'] });
    assert.equal(af.overall, 'assertion_fail', 'red check distinction: fails on assertions');
    assert.deepEqual(af.results.map((r) => r.outcome), ['assertion_fail']);
    assert.equal(runTests({ cwd: dir, scope: ['c.test.mjs'] }).overall, 'crash', 'a throwing test is a crash, not a red');
    assert.equal(runTests({ cwd: dir, scope: ['s.test.mjs'] }).overall, 'crash', 'a syntax error is a crash');
    const mixed = runTests({ cwd: dir, scope: ['p.test.mjs', 'a.test.mjs'] });
    assert.equal(mixed.overall, 'assertion_fail');
    assert.equal(mixed.results.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pester v5 is host-dependent; skip with a reason where PowerShell/Pester is absent (never false-pass).
const PS_EXE = (() => {
  for (const exe of ['pwsh', 'powershell.exe']) {
    const p = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (!p.error) return exe;
  }
  return null;
})();
const PESTER_SKIP = (() => {
  if (!PS_EXE) return 'no PowerShell on this host';
  const p = spawnSync(PS_EXE, ['-NoProfile', '-Command', 'exit ([int](-not (Get-Module -ListAvailable Pester | Where-Object { $_.Version.Major -ge 5 })))'], { encoding: 'utf8' });
  return !p.error && p.status === 0 ? false : 'Pester v5 not available';
})();

test('pester adapter: classifies pass | assertion_fail | crash against real Invoke-Pester (§9.1)', { skip: PESTER_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pester-'));
  try {
    writeFileSync(join(dir, 'p.Tests.ps1'), 'Describe "d" { It "ok"   { 1 | Should -Be 1 } }');
    writeFileSync(join(dir, 'a.Tests.ps1'), 'Describe "d" { It "af"   { 1 | Should -Be 2 } }');
    writeFileSync(join(dir, 'c.Tests.ps1'), 'Describe "d" { It "boom" { throw "x" } }');
    writeFileSync(join(dir, 's.Tests.ps1'), 'Describe "d" { It "y" {'); // unterminated -> parse/discovery error
    assert.equal(pesterRun({ cwd: dir, scope: ['p.Tests.ps1'] }).overall, 'pass');
    const af = pesterRun({ cwd: dir, scope: ['a.Tests.ps1'] });
    assert.equal(af.overall, 'assertion_fail', 'a Should failure is a red, not a crash');
    assert.deepEqual(af.results.map((r) => r.outcome), ['assertion_fail']);
    assert.equal(pesterRun({ cwd: dir, scope: ['c.Tests.ps1'] }).overall, 'crash', 'a throwing test is a crash, not a red');
    assert.equal(pesterRun({ cwd: dir, scope: ['s.Tests.ps1'] }).overall, 'crash', 'a parse/discovery error is a crash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter registry: resolveToolchains bakes declarations; unknown adapter fails loudly (§9.1/§15)', async () => {
  const baked = await resolveToolchains([{ adapter: 'node', path_globs: ['**/*.mjs'] }]);
  assert.deepEqual(baked[0].run_commands, { test: 'node --test' });
  assert.ok(baked[0].test_globs.includes('**/*.test.mjs'));
  assert.deepEqual(baked[0].capabilities, { mutation: false, static_wiring: true }, 'static_wiring live (step 7); mutation deliberately absent');
  const bakedPester = await resolveToolchains([{ adapter: 'pester', path_globs: ['**/*.Tests.ps1'] }]);
  assert.deepEqual(bakedPester[0].run_commands, { test: 'Invoke-Pester' });
  assert.ok(bakedPester[0].test_globs.includes('**/*.Tests.ps1'));
  assert.deepEqual(bakedPester[0].capabilities, { mutation: false, static_wiring: false });
  await assert.rejects(() => resolveToolchains([{ adapter: 'apex', path_globs: [] }]), /no registered adapter/);
  assert.deepEqual(await checkAdapterRegistry(), []);
});

test('none adapter: no-check toolchain — empty declarations, loud-skip runTests, registry-valid (§9.1)', async () => {
  const baked = await resolveToolchains([{ adapter: 'none', path_globs: ['**/*'] }]);
  assert.deepEqual(baked[0].capabilities, { mutation: false, static_wiring: false });
  assert.deepEqual(baked[0].test_globs, [], 'no test files — nothing for H5 to freeze');
  assert.deepEqual(baked[0].run_commands, {}, 'no test command — nothing for H14 to allowlist');
  const none = await loadAdapter('none');
  assert.equal(none.runTests({ cwd: '.', scope: [] }).overall, 'skipped', 'never a silent pass (P5)');
  assert.deepEqual(await checkAdapterRegistry(), [], 'none is a valid registry member alongside node + pester');
});

test('node adapter static_wiring: test-only exports flagged; wired and renamed exports pass (§9.1/H12)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wiring-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'wired.mjs'), 'export const used = 1;\nexport function alsoUsed() {}\n');
    writeFileSync(join(dir, 'src', 'unwired.mjs'), 'const orphan = () => 0;\nexport { orphan as exportedOrphan };\nexport class OrphanClass {}\n');
    writeFileSync(join(dir, 'src', 'app.mjs'), "import { used, alsoUsed } from './wired.mjs';\nalsoUsed(used);\n");
    writeFileSync(join(dir, 'tests', 'x.test.mjs'), "import { exportedOrphan, OrphanClass } from '../src/unwired.mjs';\nexportedOrphan(new OrphanClass());\n");
    const result = staticWiring({ cwd: dir, scope: ['src/wired.mjs', 'src/unwired.mjs'] });
    assert.deepEqual(
      result.test_only_exports.map((e) => e.name).sort(),
      ['OrphanClass', 'exportedOrphan'],
      'referenced only by tests = built-but-not-wired'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H13 reads ledger + clear
// ---------------------------------------------------------------------------

test('H13: appends normalized read-evidence to the correct ledger (run vs conductor)', () => {
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    // subagent read during a run -> run ledger
    let r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src', 'feature.ts') }, agent_id: 'a1' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const runLedger = JSON.parse(readFileSync(join(dir, '.sterling', 'runs', 'r-1', 'reads', 'agent-a1.json'), 'utf8'));
    assert.deepEqual(runLedger.map((e) => e.path), ['src/feature.ts'], 'stored repo-relative POSIX');

    // conductor read -> conductor ledger (run active or not, no agent_id = conductor)
    r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src\\types.ts' } }), dir);
    assert.equal(r.code, 0, r.stderr);
    const conductorLedger = join(dir, '.sterling', 'transient', 'conductor-reads.json');
    assert.deepEqual(JSON.parse(readFileSync(conductorLedger, 'utf8')).map((e) => e.path), ['src/types.ts']);

    // outside the repo: ignored
    r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/elsewhere/x.ts' } }), dir);
    assert.equal(r.code, 0);

    // UserPromptSubmit clears the conductor ledger (window = since last user prompt)
    r = runHook('h13-clear-conductor.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r.code, 0);
    assert.equal(existsSync(conductorLedger), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// H3 contract gate
// ---------------------------------------------------------------------------

test('H3 [run mode]: scope + read-evidence enforcement, creation exemption, out_of_scope globs', () => {
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    const edit = (path, agentId = 'a1') =>
      runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: path }, agent_id: agentId }), dir);

    // in scope but no read-evidence
    let r = edit(join(dir, 'src', 'feature.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /read-evidence/);

    // with evidence -> allowed (absolute Windows path normalized)
    seedLedger(dir, 'r-1', 'a1', ['src/feature.ts']);
    r = edit(join(dir, 'src', 'feature.ts'));
    assert.equal(r.code, 0, r.stderr);

    // outside blast radius
    r = edit(join(dir, 'src', 'other.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /outside the brief/);

    // out_of_scope glob wins
    r = edit(join(dir, 'src', 'legacy', 'old.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /out_of_scope/);

    // creating a new in-scope file needs no read-evidence
    r = edit(join(dir, 'src', 'new-file.ts'));
    assert.equal(r.code, 0, r.stderr);

    // outside the repository entirely
    r = edit('C:/elsewhere/x.ts');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /outside the repository/);

    // incidental_scope is allowed (with evidence)
    seedLedger(dir, 'r-1', 'a1', ['src/feature.ts', 'src/types.ts']);
    r = edit(join(dir, 'src', 'types.ts'));
    assert.equal(r.code, 0, r.stderr);
  } finally {
    cleanup();
  }
});

test('H3 [direct mode]: read-before-edit via conductor ledger (file-touch registration is H7, PostToolUse)', () => {
  const { dir, cleanup } = makeProject({ withRun: false });
  try {
    const edit = () =>
      runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'feature.ts') } }), dir);
    let r = edit();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /direct mode.*read-evidence/s);

    seedLedger(dir, undefined, undefined, ['src/feature.ts']);
    r = edit();
    assert.equal(r.code, 0, r.stderr);
  } finally {
    cleanup();
  }
});

test('H3 [self-protection]: spawned-agent edits to the enforcement surface deny in EVERY mode; conductor exempt', () => {
  const agentEdit = (dir, file, extra = {}) =>
    runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, file) }, agent_id: 'a1', ...extra }), dir);

  // storeless project (the strongest "every mode" case: even fail-closed paths come after)
  const bare = mkdtempSync(join(tmpdir(), 'sterling-selfprot-'));
  try {
    for (const target of ['.claude/settings.json', '.claude/settings.local.json', '.claude/agents/coder.md', '.sterling/config.json']) {
      const r = agentEdit(bare, target);
      assert.equal(r.code, 2, `${target} must deny`);
      assert.match(r.stderr, /self-protection/, target);
    }
    // bundled hooks dir, by absolute path (here: the source hooks dir the script runs from)
    const hooksDirFile = join(root, 'scripts', 'hooks', 'h6-context-watch.mjs');
    const hd = runHook('h3-contract-gate.mjs', hookInput(bare, { tool_name: 'Edit', tool_input: { file_path: hooksDirFile }, agent_id: 'a1' }), bare);
    assert.equal(hd.code, 2);
    assert.match(hd.stderr, /bundled hooks directory|self-protection/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // run mode: unconditional denial precedes scope evaluation
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    const r = agentEdit(dir, '.claude/settings.json');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /self-protection/, 'run mode does not soften the deny');

    // conductor (no agent_id) is exempt: falls through to the normal rules
    const conductor = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, '.claude', 'settings.json') } }), dir);
    assert.equal(conductor.code, 2, 'still denied — but by the brief contract, not self-protection');
    assert.match(conductor.stderr, /outside the brief/);
    assert.ok(!/self-protection/.test(conductor.stderr), 'conductor is exempt from the unconditional list');
  } finally {
    cleanup();
  }
});

test('H3: fails closed without a Sterling store (P5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nostore-'));
  try {
    const r = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'x.ts') } }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H5 frozen tests
// ---------------------------------------------------------------------------

test('H5: denies test-path edits per adapter test globs; allows source; fails closed without config', () => {
  const { dir, cleanup } = makeProject();
  try {
    const edit = (p) => runHook('h5-frozen-tests.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: p } }), dir);
    let r = edit(join(dir, 'tests', 'feature.spec.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /frozen/);
    assert.match(r.stderr, /tests-invalid/, 'points at the typed escape hatch, never silent edit');
    r = edit(join(dir, 'src', 'feature.test.mjs'));
    assert.equal(r.code, 2);
    r = edit(join(dir, 'src', 'feature.ts'));
    assert.equal(r.code, 0, r.stderr);
  } finally {
    cleanup();
  }
  const bare = mkdtempSync(join(tmpdir(), 'sterling-noconf-'));
  try {
    const r = runHook('h5-frozen-tests.mjs', hookInput(bare, { tool_name: 'Edit', tool_input: { file_path: join(bare, 'tests', 'x.test.mjs') } }), bare);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H14 Bash allowlist
// ---------------------------------------------------------------------------

test('H14: allows adapter run commands and fs helpers; denies everything else naming the allowlist', () => {
  const { dir, cleanup } = makeProject();
  try {
    const bash = (command) => runHook('h14-bash-allowlist.mjs', hookInput(dir, { tool_name: 'Bash', tool_input: { command } }), dir);
    assert.equal(bash('node --test src/').code, 0);
    assert.equal(bash('node --test').code, 0);
    assert.equal(bash('node scripts/fs-remove.mjs src/dead.ts').code, 0);
    assert.equal(bash('node "C:/plugin root/scripts/fs-move.mjs" a.ts b.ts').code, 0);
    let r = bash('git status');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not on the allowlist/);
    assert.match(r.stderr, /node --test/, 'the allowlist is named in the denial');
    assert.equal(bash('node --testx').code, 2, 'prefix needs a word boundary');
    assert.equal(bash('node fs-remove-other.mjs x').code, 2, 'fs helper pattern is exact');
    r = bash('node --test && git push');
    assert.equal(r.code, 2, 'an allowed prefix cannot smuggle a chained command');
    assert.match(r.stderr, /control operators/);
    assert.equal(bash('node --test $(rm -rf /)').code, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// H6 context watcher (observe mode default)
// ---------------------------------------------------------------------------

test('H6: computes fill from the derived agent transcript; records fills; warns at 60+; observe never denies', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const h6 = (event, agentId = 'a1') =>
      runHook('h6-context-watch.mjs', hookInput(dir, { hook_event_name: event, tool_name: 'Edit', tool_input: {}, agent_id: agentId, agent_type: 'coder' }), dir);

    // conductor calls are a no-op (statusline owns conductor fill)
    assert.equal(runHook('h6-context-watch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }), dir).code, 0);

    // 30% fill: recorded, no warn
    writeAgentTranscript(dir, 'a1', 60_000);
    assert.equal(h6('PostToolUse').code, 0);
    const fills = readFileSync(join(dir, '.sterling', 'runs', 'r-1', 'h6-fills.jsonl'), 'utf8').trim().split('\n');
    assert.equal(fills.length, 1);
    assert.equal(JSON.parse(fills[0]).fill_pct, 30);
    assert.equal(store.getRun('r-1').escalations.length, 0);

    // 65%: warn flagged to the run record
    writeAgentTranscript(dir, 'a1', 130_000);
    assert.equal(h6('PostToolUse').code, 0);
    const esc = store.getRun('r-1').escalations;
    assert.equal(esc.length, 1);
    assert.equal(esc[0].kind, 'context_warn');
    assert.equal(esc[0].fill_pct, 65);

    // 96% PreToolUse in observe mode: records, never denies (§16.1: H6 observe)
    writeAgentTranscript(dir, 'a1', 192_000);
    const observed = h6('PreToolUse');
    assert.equal(observed.code, 0, observed.stderr);

    // unparseable usage -> degraded loudly via check_skipped, tool proceeds
    writeAgentTranscript(dir, 'a1', 0, { withUsage: false });
    const degraded = h6('PostToolUse');
    assert.equal(degraded.code, 0);
    assert.match(degraded.stderr, /degraded loudly/);
    assert.ok(store.listCheckSkipped('r-1').some((s) => s.check_name === 'context-watch' && s.reason === 'format_unparseable'));

    // missing transcript -> also loud, never breaks the tool call
    const missing = h6('PostToolUse', 'a-ghost');
    assert.equal(missing.code, 0);
    assert.ok(store.listCheckSkipped('r-1').some((s) => s.reason === 'transcript_missing'));
  } finally {
    cleanup();
  }
});

test('H6 [enforce mode]: 95%+ on PreToolUse denies with phase-overflow guidance', () => {
  const config = { ...CONFIG, context_watch: { ...CONFIG.context_watch, mode: 'enforce' } };
  const { dir, cleanup } = makeProject({ withRun: true, config });
  try {
    writeAgentTranscript(dir, 'a1', 192_000);
    const r = runHook('h6-context-watch.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, agent_id: 'a1' }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /phase-overflow/);
    assert.match(r.stderr, /96\.0%/);
  } finally {
    cleanup();
  }
});

test('H6 self-check at SessionStart: parseable -> quiet; assistant-without-usage -> check_skipped; fresh session -> quiet', () => {
  const { dir, store, cleanup } = makeProject({ withRun: false });
  try {
    const transcript = join(dir, 'transcripts', 's1.jsonl');
    mkdirSync(dirname(transcript), { recursive: true });

    // conductor transcript with parseable usage
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n');
    let r = runHook('h6-selfcheck.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir);
    assert.equal(r.code, 0);
    assert.equal(store.listCheckSkipped().length, 0);

    // assistant entries but no usage -> format_unparseable, loud
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'm' } }) + '\n');
    r = runHook('h6-selfcheck.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /degraded loudly/);
    assert.ok(store.listCheckSkipped().some((s) => s.check_name === 'context-watch'));

    // fresh session: no assistant entries at all is not a failure
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    const skipsBefore = store.listCheckSkipped().length;
    r = runHook('h6-selfcheck.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir);
    assert.equal(r.code, 0);
    assert.equal(store.listCheckSkipped().length, skipsBefore);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// §6 emission rule + bundling (invariant 4)
// ---------------------------------------------------------------------------

test('hooks.json emission check: shipped file is clean; backslash commands are flagged', () => {
  const shipped = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(findBackslashCommandsInHooksJson(shipped), []);
  const bad = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "C:\\plugin\\hooks\\h3.mjs"' }] }] } };
  assert.equal(findBackslashCommandsInHooksJson(bad).length, 1);
});

test('bundled hooks are standalone: esbuild output runs without workspace resolution (invariant 4)', () => {
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-hooks.mjs')], { encoding: 'utf8', cwd: root, timeout: 120_000 });
  assert.equal(build.status, 0, build.stderr);
  const bundled = join(root, 'hooks', 'h5-frozen-tests.mjs');
  assert.ok(existsSync(bundled));
  assert.ok(!readFileSync(bundled, 'utf8').includes("from '@sterling/"), 'no workspace imports at runtime');

  const { dir, cleanup } = makeProject();
  try {
    const r = spawnSync(process.execPath, [bundled], {
      input: JSON.stringify(hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'tests', 'x.test.mjs') } })),
      encoding: 'utf8',
      cwd: dir,
      timeout: 30_000,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr ?? '', /frozen/);

    // EVERY bundled hook must run standalone on a benign input — a bundled
    // dependency with main-detection once turned h10 into an exit-2 at import
    // (found live; this guards the whole set).
    const benign = {
      PreToolUse: { tool_name: 'Glob', tool_input: {} },
      PostToolUse: { tool_name: 'Glob', tool_input: {}, tool_response: {} },
      Stop: {},
      SessionStart: {},
      UserPromptSubmit: {},
    };
    const events = {
      'h1-session-start.mjs': 'SessionStart',
      'h2-selection-inject.mjs': 'UserPromptSubmit',
      'h6-selfcheck.mjs': 'SessionStart',
      'h7-file-touch.mjs': 'PostToolUse',
      'h9-stop-backstop.mjs': 'Stop',
      'h10-direct-capture.mjs': 'Stop',
      'h13-clear-conductor.mjs': 'UserPromptSubmit',
      'h13-reads-ledger.mjs': 'PostToolUse',
    };
    for (const [file, event] of Object.entries(events)) {
      const res = spawnSync(process.execPath, [join(root, 'hooks', file)], {
        input: JSON.stringify(hookInput(dir, { hook_event_name: event, ...benign[event] })),
        encoding: 'utf8',
        cwd: dir,
        timeout: 30_000,
      });
      assert.equal(res.status, 0, `${file} on benign ${event}: exit ${res.status} — ${res.stderr}`);
    }
  } finally {
    cleanup();
  }
});
