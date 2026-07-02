import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
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

test('adapter: TS-source package tests are built + run from dist (Node16 .js imports), classified per-test not crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tsadapter-'));
  try {
    // mimic the package layout: Node16 ESM tsconfig, rootDir src -> outDir dist.
    // package.json `type: module` keys tsc's ESM emit; `types: ['node']` lets
    // the test source reference node:test/node:assert.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0', private: true, type: 'module' }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', rootDir: 'src', outDir: 'dist', strict: true, types: ['node'] },
        include: ['src/**/*'],
      })
    );
    mkdirSync(join(dir, 'src', 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    // imports the sibling via `.js` — only resolves under dist, so running the
    // .ts directly would fail to LOAD (the false crash this fix removes)
    writeFileSync(
      join(dir, 'src', 'tests', 'foo.test.ts'),
      "import {test} from 'node:test'; import assert from 'node:assert'; import {x} from '../index.js';\n" +
        "test('ok', () => assert.equal(x, 1));\n" +
        "test('af', () => assert.equal(x, 2));\n"
    );
    // tsc resolves from the fixture's node_modules; symlink it to the repo's so
    // the compiler JS entry + lib are reachable (the fix runs typescript/bin/tsc
    // through node, cross-platform).
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');

    const r = runTests({ cwd: dir, scope: ['src/tests/foo.test.ts'] });
    assert.equal(r.overall, 'assertion_fail', 'built + run from dist, the failing assertion classifies red — not crash');
    assert.deepEqual(r.results.map((x) => x.outcome).sort(), ['assertion_fail', 'pass']);

    // a passing-only TS test -> pass
    writeFileSync(
      join(dir, 'src', 'tests', 'pass.test.ts'),
      "import {test} from 'node:test'; import assert from 'node:assert'; import {x} from '../index.js';\n" +
        "test('ok', () => assert.equal(x, 1));\n"
    );
    assert.equal(runTests({ cwd: dir, scope: ['src/tests/pass.test.ts'] }).overall, 'pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter: TS-source remap anchors to the OWNING package, not the first src/ (nested-src)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tsnest-'));
  try {
    // a `src` segment ABOVE the package: the owning tsconfig is at the INNER
    // package (app/src/feature). The remap must hit app/src/feature/dist/...,
    // never app/dist/feature/src/... — the latter would be a false crash.
    const pkg = join(dir, 'app', 'src', 'feature');
    mkdirSync(join(pkg, 'src', 'tests'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'inner', version: '0.0.0', private: true, type: 'module' }));
    writeFileSync(
      join(pkg, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', rootDir: 'src', outDir: 'dist', strict: true, types: ['node'] },
        include: ['src/**/*'],
      })
    );
    writeFileSync(join(pkg, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(pkg, 'src', 'tests', 'foo.test.ts'),
      "import {test} from 'node:test'; import assert from 'node:assert'; import {x} from '../index.js';\n" +
        "test('ok', () => assert.equal(x, 1));\n"
    );
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');

    const r = runTests({ cwd: dir, scope: ['app/src/feature/src/tests/foo.test.ts'] });
    assert.equal(r.overall, 'pass', 'remapped to the inner dist, built + run cleanly — not a crash from a misanchored remap');
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

test('H6 self-check at SessionStart: parseable -> quiet; assistant-without-usage -> check_skipped; fresh session -> quiet; missing transcript -> quiet', () => {
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

    // missing transcript (fresh startup, before the file is created): NORMAL, not a
    // failure — nothing to parse says nothing about format drift. Flagging it
    // produced a false "self-check failed" on every fresh launch.
    const before = store.listCheckSkipped().length;
    r = runHook('h6-selfcheck.mjs', hookInput(dir, { hook_event_name: 'SessionStart', transcript_path: join(dir, 'transcripts', 'does-not-exist.jsonl') }), dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /degraded loudly/);
    assert.equal(store.listCheckSkipped().length, before, 'a missing transcript records no check_skipped');
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

// ===========================================================================
// H17 — dual-mode Bash write-sweep (v3.1 hardened hybrid). Decision 2422e76a.
//
// Under test: scripts/hooks/h17-bash-write-sweep.mjs — registered on the coder
// frontmatter's PreToolUse Bash (baseline snapshot) AND PostToolUse Bash (verify
// + restore). It closes the H14 `node --test <writer>` arbitrary-write bypass
// (decision f404dfb4) by detecting, after an agent's Bash command, any write to:
//   (A) tracked files — via `git status --porcelain -z` (HEAD-anchored restore),
//       a VIOLATION iff isEnforcementSurface(rel) || matchesGlob(rel,'hooks/**')
//       OR (run+brief resolvable AND scopeCheck({brief,rel}).deny);
//   (B) the gitignored BASELINE set — `.claude/agents/**` + `.sterling/config.json`
//       + `.claude/settings*.json` (v3.1 NEW; NOT sterling.db), snapshotted Pre to
//       os.tmpdir()/sterling-enforce-<runId>.json and diffed Post.
// v3.1 UNIVERSAL FAIL-CLOSED: during an active agent run ANY unexpected error
// (missing/corrupt baseline, restore fs-error, store/git throw, brief-unresolvable)
// DENIES (exit 2), NEVER a non-blocking exit 1. Non-deny only: no agent_id
// (conductor) → allow; no active run (L2) → baseline + always-set only.
//
// ACCEPTED determined-attacker residuals (decision 2422e76a, option A) — NOT
// tested here because asserting the hook blocks them would be an incorrect,
// unpassable oracle: (A) a tamper the agent `git commit`s (HEAD-anchor restores
// the committed tamper); (B) a forged baseline overwritten to match a tamper.
// Both are out of f404dfb4's "well-meaning agent" threat model.
//
// The fixture is a real temp git repo (init + identity + initial commit) whose
// .gitignore mirrors v3.1 reality: hooks/*.mjs + hooks/hooks.json + source + tests
// TRACKED; .claude/agents/ + .claude/settings.local.json + .sterling/ IGNORED.
// ===========================================================================

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

// run git in `dir` (setup helper — never silently swallows a setup failure: P5)
function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

// the same brief the node-adapter fixture uses: in-scope src/feature.ts +
// src/new-file.ts, incidental src/types.ts, out_of_scope src/legacy/** — so
// scopeCheck denies every OTHER repo path.
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

// Build a git-backed project with a live Sterling store + active run.
// `briefRef` overrides the run's brief_ref (AC9f: a well-formed but unresolvable
// ref). `activeRun:false` gives the L2 no-run posture.
function makeGitProject({ activeRun = true, briefRef, config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-'));
  const runId = 'r-h17-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);

  // .gitignore = v3.1 reality
  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  // TRACKED bundled hooks (hooks/*.mjs + hooks/hooks.json)
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');

  // TRACKED source + frozen tests
  mkdirSync(join(dir, 'src', 'legacy'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n'); // in-scope
  writeFileSync(join(dir, 'src', 'types.ts'), 'export type T = 1;\n'); // incidental
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 1;\n'); // out-of-contract tracked
  writeFileSync(join(dir, 'src', 'a b.ts'), 'export const spaced = 1;\n'); // out-of-contract, spaced path
  writeFileSync(join(dir, 'src', 'legacy', 'old.ts'), 'export const legacy = 1;\n'); // out_of_scope
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'frozen.test.mjs'), "import { test } from 'node:test';\ntest('frozen', () => {});\n");

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  // gitignored enforcement surface (present so (B) can snapshot a baseline)
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  // store + active run
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  let store = new SterlingStore(dbPath);
  let brief, run;
  if (activeRun) {
    let ref = briefRef;
    if (ref === undefined) {
      brief = store.create(briefRecord());
      ref = brief.id;
    }
    run = store.createRun({
      id: runId,
      brief_ref: ref,
      branch: 'sterling/' + runId,
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
    });
  }

  const baselinePath = join(tmpdir(), 'sterling-enforce-' + runId + '.json');
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
    rmSync(baselinePath, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true });
  };
  return { dir, store, run, brief, runId, dbPath, baselinePath, closeStore, cleanup };
}

// run h17 in Pre (snapshot) or Post (verify+sweep) mode. agent_id passed via `over`.
function h17(dir, event, over = {}) {
  return runHook(
    'h17-bash-write-sweep.mjs',
    hookInput(dir, {
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'node --test src/x.mjs' },
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    }),
    dir
  );
}

const A1 = { agent_id: 'a1' };

// ---------------------------------------------------------------------------
// AC1 — tracked bundled hooks (hooks.json + a bundled hook): tamper → deny + git-checkout-HEAD restore
// ---------------------------------------------------------------------------

test('H17 AC1: tampering tracked hooks/hooks.json + a bundled hooks/*.mjs → exit 2 + HEAD restore', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const bundled = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const origJson = readFileSync(hooksJson, 'utf8');
    const origHook = readFileSync(bundled, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0, 'Pre snapshot succeeds');
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true }));
    writeFileSync(bundled, '// TAMPERED — enforcement neutered\nprocess.exit(0);\n');

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `hooks/** tamper must deny — ${r.stderr}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), origJson, 'hooks.json restored via git checkout HEAD');
    assert.equal(readFileSync(bundled, 'utf8'), origHook, 'bundled hook restored via git checkout HEAD');
    assert.match(r.stderr, /hooks\.json/, 'the denial names hooks.json');
    assert.match(r.stderr, /h3-contract-gate/, 'the denial names the bundled hook');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — out-of-contract tracked FROZEN test tampered → deny + restore (caught via scopeCheck)
// ---------------------------------------------------------------------------

test('H17 AC2: out-of-contract tracked frozen test tampered → exit 2 + checkout restore', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const frozen = join(dir, 'tests', 'frozen.test.mjs');
    const orig = readFileSync(frozen, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(frozen, orig + "\ntest('injected', () => {}); // weakened via node --test writer\n");

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 2, `out-of-blast-radius test edit must deny — ${r.stderr}`);
    assert.equal(readFileSync(frozen, 'utf8'), orig, 'frozen test restored to HEAD');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — out-of-contract source: modified→checkout; untracked FILE→deleted; untracked DIR→removed recursively
// ---------------------------------------------------------------------------

test('H17 AC3: out-of-contract source — modified→checkout, untracked file→delete, untracked dir(?? dir/)→rm -r', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // (a) tracked out-of-contract source MODIFIED → restore via checkout
    const other = join(dir, 'src', 'other.ts');
    const origOther = readFileSync(other, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(other, origOther + '\n// out-of-contract tamper\n');
    let r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `modified out-of-contract source must deny — ${r.stderr}`);
    assert.equal(readFileSync(other, 'utf8'), origOther, 'modified source restored via git checkout HEAD');

    // (b) UNTRACKED out-of-contract FILE → deleted
    const evilFile = join(dir, 'src', 'evil.mjs');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(evilFile, 'console.log("planted");\n');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `untracked out-of-contract file must deny — ${r.stderr}`);
    assert.equal(existsSync(evilFile), false, 'untracked out-of-contract file deleted');

    // (c) UNTRACKED out-of-contract DIR — git collapses to `?? src/evildir/` → removed recursively
    const evilDir = join(dir, 'src', 'evildir');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'a.ts'), 'x');
    writeFileSync(join(evilDir, 'b.ts'), 'y');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `untracked out-of-contract dir must deny — ${r.stderr}`);
    assert.equal(existsSync(evilDir), false, 'untracked dir removed recursively (?? dir/ collapse handled)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — no false block: in-contract edit + new in-scope file untouched; clean tree → 0
// ---------------------------------------------------------------------------

test('H17 AC4: no false block — clean tree → 0; in-scope edit + new in-scope file allowed & untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // clean tree → allow
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    let r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 0, `clean tree must allow — ${r.stderr}`);

    // an in-blast-radius edit + a new in-scope file: allowed AND left intact
    const feature = join(dir, 'src', 'feature.ts'); // in blast radius
    const editedFeature = readFileSync(feature, 'utf8') + '\n// legit in-scope edit\n';
    const newInScope = join(dir, 'src', 'new-file.ts'); // in blast radius (creation allowed)
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(feature, editedFeature);
    writeFileSync(newInScope, 'export const created = 1;\n');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 0, `in-scope work must not be blocked — ${r.stderr}`);
    assert.equal(readFileSync(feature, 'utf8'), editedFeature, 'in-scope edit NOT reverted');
    assert.ok(existsSync(newInScope), 'new in-scope file NOT deleted');
    assert.equal(readFileSync(newInScope, 'utf8'), 'export const created = 1;\n', 'new in-scope file untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — conductor (no agent_id) → allow, short-circuit BEFORE store/git (tamper NOT restored)
// ---------------------------------------------------------------------------

test('H17 AC5: no agent_id (conductor) → exit 0, nothing touched, short-circuits before store/git', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const tampered = JSON.stringify({ hooks: {}, TAMPERED: true });
    // deliberately no Pre snapshot — the conductor path must return before it
    // would ever consult the baseline, the store, or git.
    writeFileSync(hooksJson, tampered);
    const r = h17(dir, 'PostToolUse'); // NO agent_id
    assert.equal(r.code, 0, `conductor legitimately edits the enforcement surface — must allow (${r.stderr})`);
    assert.equal(readFileSync(hooksJson, 'utf8'), tampered, 'conductor edit NOT restored — proves the short-circuit before git');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC8 (v3.1 EXPANDED) — gitignored enforcement writes caught via the (B) baseline + restored;
//   agents/evil.md (new→delete), .sterling/config.json (modified→restore),
//   .claude/settings.local.json (v3.1 NEW, modified→restore). sterling.db change NOT flagged.
// ---------------------------------------------------------------------------

test('H17 AC8: gitignored (B)-set writes caught via baseline + restored; sterling.db NOT flagged', { skip: GIT_SKIP }, () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    // --- .claude/agents/evil.md : NEW → deleted ---
    const evilAgent = join(dir, '.claude', 'agents', 'evil.md');
    const legitAgent = join(dir, '.claude', 'agents', 'coder.md');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(evilAgent, '# smuggled agent (hooks stripped)\n');
    let r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `new gitignored agent file must deny — ${r.stderr}`);
    assert.equal(existsSync(evilAgent), false, 'new (B)-set file deleted (restore to baseline-absent)');
    assert.ok(existsSync(legitAgent), 'a legit pre-existing agent file is left untouched');

    // --- .sterling/config.json : MODIFIED → restored (kept valid so h17 config reads still succeed) ---
    const configPath = join(dir, '.sterling', 'config.json');
    const origConfig = readFileSync(configPath, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(configPath, JSON.stringify({ ...CONFIG, HACKED: true }));
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `modified gitignored config must deny — ${r.stderr}`);
    assert.equal(readFileSync(configPath, 'utf8'), origConfig, '.sterling/config.json restored to baseline');

    // --- .claude/settings.local.json (the GITIGNORED hook-disable file, v3.1 NEW): MODIFIED → restored ---
    const settingsLocal = join(dir, '.claude', 'settings.local.json');
    const origSettings = readFileSync(settingsLocal, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(settingsLocal, JSON.stringify({ hooks: 'DISABLED' }));
    r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 2, `v3.1: gitignored settings.local.json write must deny — ${r.stderr}`);
    assert.equal(readFileSync(settingsLocal, 'utf8'), origSettings, 'settings.local.json restored to baseline');

    // --- sterling.db change is NOT in the (B) set and git is blind to it → NOT flagged ---
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    store.create(briefRecord()); // a legit store write mutates sterling.db between Pre and Post
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 0, `a sterling.db change must NOT be flagged (${r.stderr})`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC9 (v3.1 UNIVERSAL FAIL-CLOSED) — every can't-verify path during an active agent run
// DENIES (exit 2), explicitly NEVER a non-blocking exit 1.
// ---------------------------------------------------------------------------

test('H17 AC9a: missing baseline at Post (no Pre snapshot) → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baselinePath } = makeGitProject();
  try {
    rmSync(baselinePath, { force: true }); // ensure absent — no Pre ran
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'must not fail open on a missing baseline');
    assert.equal(r.code, 2, `missing baseline during active run → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H17 AC9b: corrupt/unparseable baseline → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baselinePath } = makeGitProject();
  try {
    writeFileSync(baselinePath, '{ this is : not valid json ,,, ');
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'must not fail open on an unparseable baseline');
    assert.equal(r.code, 2, `corrupt baseline → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H17 AC9c: restore fs-error (deterministic EISDIR dir-swap) → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const configPath = join(dir, '.sterling', 'config.json');
    // Pre snapshots config.json as a FILE...
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    // ...then swap the file for a DIRECTORY of the same name: on restore, h17's
    // read/write of that path throws EISDIR — a deterministic restore fs-error.
    rmSync(configPath, { force: true });
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, 'blocker'), 'x');
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a restore fs-error must not fail open');
    assert.equal(r.code, 2, `restore fs-error → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H17 AC9d: store/resolveRun throw (corrupt sterling.db) → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, closeStore, dbPath } = makeGitProject();
  try {
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0); // baseline present — isolate the store throw as the cause
    closeStore(); // release the fixture's handle before corrupting the db file
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    writeFileSync(dbPath, 'this is not a sqlite database — resolveRun must throw');
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a store throw during an active agent run must not fail open (voids AC1)');
    assert.equal(r.code, 2, `corrupt store → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H17 AC9e: git error/nonzero (corrupt .git/index) → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    // Force `git status --porcelain -z` to exit nonzero deterministically: a
    // corrupt index makes git fatal on every version (index.lock alone can be
    // skipped as an optional lock and still exit 0, so it is not reliable here).
    writeFileSync(join(dir, '.git', 'index'), 'corrupt index bytes — not a valid git index file');
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a git error must not fail open');
    assert.equal(r.code, 2, `git nonzero → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H17 AC9f: run active but brief unresolvable → deny, not exit 1', { skip: GIT_SKIP }, () => {
  // a well-formed brief_ref that resolves to no record (unlike H3, this must fail CLOSED)
  const { dir, cleanup } = makeGitProject({ briefRef: randomUUID() });
  try {
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0); // baseline present — isolate brief-unresolvable
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'brief-unresolvable during an active run must not fail open');
    assert.equal(r.code, 2, `run active + brief unresolvable → deny — ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC10 — crafted baseline with traversal ../ + absolute keys → rejected before write, no out-of-tree write, deny
// ---------------------------------------------------------------------------

test('H17 AC10: crafted baseline with ../ + absolute keys → deny + NO out-of-tree write', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baselinePath, runId } = makeGitProject();
  const outParent = join(dir, '..', 'pwned-' + runId + '.txt'); // traversal escape target
  const outAbs = join(tmpdir(), 'pwned-abs-' + runId + '.txt'); // absolute escape target
  try {
    // Craft a baseline whose KEYS escape the tree. h17 must validate every key
    // (repo-relative POSIX + matches a (B) glob; reject traversal/absolute)
    // BEFORE any restore write — so the escape files are never created.
    // NOTE: both keys are computed expressions → they MUST be bracketed computed
    // properties; a bare `expr: value` object key is a JS syntax error.
    writeFileSync(
      baselinePath,
      JSON.stringify({
        ['../pwned-' + runId + '.txt']: 'traversal payload',
        [outAbs]: 'absolute payload',
      })
    );
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 2, `a baseline with traversal/absolute keys must deny — ${r.stderr}`);
    assert.equal(existsSync(outParent), false, 'no out-of-tree write via ../ traversal key');
    assert.equal(existsSync(outAbs), false, 'no out-of-tree write via absolute key');
  } finally {
    cleanup([outParent, outAbs]);
  }
});

// ---------------------------------------------------------------------------
// AC11 — rename R dual-path (git mv restore); spaced path via -z; multiple violations → one deny naming each
// ---------------------------------------------------------------------------

test('H17 AC11 (rename): staged out-of-contract rename (R, dual-path) → deny + origin restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const origin = join(dir, 'src', 'other.ts'); // out-of-contract tracked
    const target = join(dir, 'src', 'renamed.ts');
    const origContent = readFileSync(origin, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    // stage a rename so `git status --porcelain -z` reports `R  new\0old` (both paths)
    git(dir, ['mv', 'src/other.ts', 'src/renamed.ts'], { must: true });

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 2, `staged rename of an out-of-contract file must deny — ${r.stderr}`);
    assert.ok(existsSync(origin), 'rename origin restored (dual-path handled)');
    assert.equal(readFileSync(origin, 'utf8'), origContent, 'origin content restored');
    assert.equal(existsSync(target), false, 'rename destination removed');
  } finally {
    cleanup();
  }
});

test('H17 AC11 (spaced path): out-of-contract path with a space parsed via -z → deny + restore', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const spaced = join(dir, 'src', 'a b.ts'); // out-of-contract, embedded space
    const orig = readFileSync(spaced, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(spaced, orig + '\n// tamper on a spaced path\n');
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `spaced-path change must deny — ${r.stderr}`);
    assert.equal(readFileSync(spaced, 'utf8'), orig, 'spaced path restored — proves -z NUL parsing (no space-split)');
  } finally {
    cleanup();
  }
});

test('H17 AC11 (multiple): two out-of-contract violations → ONE deny naming each + both restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const other = join(dir, 'src', 'other.ts'); // outside blast radius
    const legacy = join(dir, 'src', 'legacy', 'old.ts'); // out_of_scope
    const origOther = readFileSync(other, 'utf8');
    const origLegacy = readFileSync(legacy, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(other, origOther + '\n// tamper 1\n');
    writeFileSync(legacy, origLegacy + '\n// tamper 2\n');

    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `multiple violations must deny — ${r.stderr}`);
    assert.match(r.stderr, /other\.ts/, 'the single deny names the first violation');
    assert.match(r.stderr, /old\.ts/, 'the single deny names the second violation');
    assert.equal(readFileSync(other, 'utf8'), origOther, 'first violation restored');
    assert.equal(readFileSync(legacy, 'utf8'), origLegacy, 'second violation restored');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// contract.mjs unit block — isEnforcementSurface(rel): hits, hooks/** excluded (h17-side), arity 1
// (guarded import: assert the export exists — never a link-crash that reds the whole file)
// ---------------------------------------------------------------------------

test('H17 unit: isEnforcementSurface(rel) — surface hits, hooks/** excluded (h17-side), arity 1', async () => {
  const mod = await import(pathToFileURL(join(HOOKS, 'lib', 'contract.mjs')).href).catch((e) => ({ __err: e }));
  assert.ok(mod && typeof mod.isEnforcementSurface === 'function', 'scripts/hooks/lib/contract.mjs must export isEnforcementSurface(rel)');
  const { isEnforcementSurface, ENFORCEMENT_SURFACE } = mod;

  // hits — the enforcement surface
  assert.equal(isEnforcementSurface('.claude/agents/coder.md'), true, '.claude/agents/** (recursion)');
  assert.equal(isEnforcementSurface('.claude/agents/nested/deep.md'), true, '.claude/agents/** recurses');
  assert.equal(isEnforcementSurface('.sterling/config.json'), true, '.sterling/config.json');
  assert.equal(isEnforcementSurface('.claude/settings.json'), true, 'settings*.json');
  assert.equal(isEnforcementSurface('.claude/settings.local.json'), true, 'settings*.json glob covers the gitignored variant');

  // misses — hooks/** is deliberately NOT part of isEnforcementSurface on the
  // h17 side (h17 pins hooks/** with a SEPARATE matchesGlob check); ordinary source misses too
  assert.equal(isEnforcementSurface('hooks/hooks.json'), false, 'hooks/** is NOT in isEnforcementSurface (h17-side, no hooksRel)');
  assert.equal(isEnforcementSurface('hooks/h3-contract-gate.mjs'), false, 'hooks/*.mjs is NOT in isEnforcementSurface');
  assert.equal(isEnforcementSurface('src/feature.ts'), false, 'ordinary source is not enforcement surface');

  // arity 1 — signature is (rel), no hooksRel parameter
  assert.equal(isEnforcementSurface.length, 1, 'isEnforcementSurface takes exactly one argument (rel)');

  // ENFORCEMENT_SURFACE stays the declared triple (unchanged in v3.1)
  assert.deepEqual(
    [...ENFORCEMENT_SURFACE].sort(),
    ['.claude/agents/**', '.claude/settings*.json', '.sterling/config.json'].sort(),
    'ENFORCEMENT_SURFACE is the three-glob enforcement set'
  );
  assert.equal(ENFORCEMENT_SURFACE.length, 3);
});
