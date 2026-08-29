import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, statSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runTests, staticWiring } from '../adapters/node.mjs';
import { runTests as pesterRun } from '../adapters/pester.mjs';
import { resolveToolchains, checkAdapterRegistry, loadAdapter } from '../adapters/resolve.mjs';
import { findBackslashCommandsInHooksJson } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Mutation seam (slice S1, board 5402a024) — mirrors h24-gate-exit-lint.test.mjs:48.
// STERLING_HOOKS_DIR lets a clean-room mutation run point this suite at a mutant
// bundle. Unset falls back to today's hard-coded scripts/hooks — byte-identical
// behavior to before this seam existed.
const HOOKS = process.env.STERLING_HOOKS_DIR || join(root, 'scripts', 'hooks');
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

// Anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// an assertion message that is EXPECTED to fail poisons the TAP crash/assertion
// classifier — the multi-line `code:` diagnostic starts a YAML line, so
// ERR_ASSERTION is no longer the first `code:` the parser sees and the outcome
// classifies as a CRASH instead of assertion_fail. A red gate then cannot tell
// "the pin caught the sabotage" from "the harness fell over", which is exactly
// what a mutation battery rests on. Flatten whitespace only — NEVER truncate:
// the whole message must stay readable when a pin fires.
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

test('adapter: describe()/nested subtests classify by the LEAF, not the suite aggregate (audit finding 8/43)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-adapter-nested-'));
  try {
    // a failing assertion INSIDE a describe was previously read as the suite's
    // ERR_TEST_FAILURE → crash, refusing a valid TDD red. It must classify red.
    writeFileSync(
      join(dir, 'nested-af.test.mjs'),
      "import {describe,it} from 'node:test'; import assert from 'node:assert'; describe('s',()=>{ it('t',()=>assert.equal(1,2)); });"
    );
    const af = runTests({ cwd: dir, scope: ['nested-af.test.mjs'] });
    assert.equal(af.overall, 'assertion_fail', 'describe-nested assertion failure is a red, not a crash');
    assert.deepEqual(af.results.map((r) => r.outcome), ['assertion_fail'], 'only the leaf counts; the suite aggregate is skipped');

    // a THROW inside a describe is still a crash (leaf carries ERR_TEST_FAILURE
    // like the suite, so the discriminator is type:test vs type:suite, not code)
    writeFileSync(
      join(dir, 'nested-crash.test.mjs'),
      "import {describe,it} from 'node:test'; describe('s',()=>{ it('t',()=>{ throw new Error('boom'); }); });"
    );
    assert.equal(runTests({ cwd: dir, scope: ['nested-crash.test.mjs'] }).overall, 'crash', 'a throw in a describe is still a crash');

    // deeply nested (2 levels) assertion also classifies red
    writeFileSync(
      join(dir, 'deep.test.mjs'),
      "import {describe,it} from 'node:test'; import assert from 'node:assert'; describe('o',()=>{ describe('i',()=>{ it('d',()=>assert.equal('a','b')); }); });"
    );
    assert.equal(runTests({ cwd: dir, scope: ['deep.test.mjs'] }).overall, 'assertion_fail', 'two-level nested assertion is a red');

    // a passing describe stays pass and does not double-count the suite line
    writeFileSync(
      join(dir, 'pass.test.mjs'),
      "import {describe,it} from 'node:test'; import assert from 'node:assert'; describe('s',()=>{ it('a',()=>assert.equal(1,1)); it('b',()=>assert.equal(2,2)); });"
    );
    const pass = runTests({ cwd: dir, scope: ['pass.test.mjs'] });
    assert.equal(pass.overall, 'pass');
    assert.equal(pass.results.length, 2, 'two leaf tests counted, the suite aggregate skipped');
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

test('node adapter static_wiring: a same-module caller wires an export even when only a test imports it directly (board 5ef993c1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wiring-samefile-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    // helper is exported only so the frozen test oracle can exercise it
    // directly, but every runtime call is same-module (publicApi calls it
    // internally) — that must not read as built-but-not-wired.
    writeFileSync(
      join(dir, 'src', 'internal.mjs'),
      "export function helper() { return 1; }\nexport function publicApi() { return helper() + 1; }\n"
    );
    writeFileSync(
      join(dir, 'tests', 'internal.test.mjs'),
      "import { helper } from '../src/internal.mjs';\nhelper();\n"
    );
    const result = staticWiring({ cwd: dir, scope: ['src/internal.mjs'] });
    assert.deepEqual(result.test_only_exports, [], 'helper is wired via same-module use by publicApi, not just the test import');
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
    assert.equal(r.code, 0, oneLine(r.stderr));
    const runLedger = JSON.parse(readFileSync(join(dir, '.sterling', 'runs', 'r-1', 'reads', 'agent-a1.json'), 'utf8'));
    assert.deepEqual(runLedger.map((e) => e.path), ['src/feature.ts'], 'stored repo-relative POSIX');

    // conductor read -> conductor ledger (run active or not, no agent_id = conductor)
    r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src\\types.ts' } }), dir);
    assert.equal(r.code, 0, oneLine(r.stderr));
    const conductorLedger = join(dir, '.sterling', 'transient', 'conductor-reads.json');
    assert.deepEqual(JSON.parse(readFileSync(conductorLedger, 'utf8')).map((e) => e.path), ['src/types.ts']);

    // outside the repo: ignored
    r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/elsewhere/x.ts' } }), dir);
    assert.equal(r.code, 0);

    // UserPromptSubmit prunes HASHLESS legacy entries only (board 776d2b65) —
    // the hashed entry the h13-reads-ledger hook just wrote SURVIVES the prompt
    // boundary; evidence now expires with the file, not the prompt.
    const before = JSON.parse(readFileSync(conductorLedger, 'utf8'));
    assert.ok(before.every((e) => e.sha256), 'h13-reads-ledger stamps a content hash on every entry');
    r = runHook('h13-clear-conductor.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r.code, 0);
    assert.equal(existsSync(conductorLedger), true, 'hashed entries survive the prompt clear');
    // seed a hashless legacy entry beside it — the prompt clear prunes exactly that one
    const mixed = [...JSON.parse(readFileSync(conductorLedger, 'utf8')), { agent_id: 'conductor', path: 'src/legacy-read.ts', at: NOW }];
    writeFileSync(conductorLedger, JSON.stringify(mixed));
    r = runHook('h13-clear-conductor.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r.code, 0);
    const after = JSON.parse(readFileSync(conductorLedger, 'utf8'));
    assert.ok(after.every((e) => e.sha256), 'hashless legacy entries are pruned at the prompt boundary');
    assert.ok(!after.some((e) => e.path === 'src/legacy-read.ts'));
  } finally {
    cleanup();
  }
});

test('H3 [direct mode]: evidence expires with the FILE — a hashed read survives prompts and dies on content change (board 776d2b65)', () => {
  const { dir, cleanup } = makeProject({ withRun: false });
  try {
    const target = join(dir, 'src', 'feature.ts');
    // real read through the hook so the entry carries the live content hash
    let r = runHook('h13-reads-ledger.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: target } }), dir);
    assert.equal(r.code, 0, oneLine(r.stderr));
    // prompt boundary: hashed evidence survives …
    runHook('h13-clear-conductor.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    r = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: target } }), dir);
    assert.equal(r.code, 0, `byte-current file read before an earlier prompt must stay editable: ${oneLine(r.stderr)}`);
    // … until the FILE changes, which is the actual staleness
    writeFileSync(target, 'export const changed = true;\n');
    r = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: target } }), dir);
    assert.equal(r.code, 2, 'a changed file expires the evidence');
    assert.match(r.stderr, /no fresh read-evidence/);
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
    // Separation pin (board c7b81456 review): an ordinary misconduct denial
    // must never carry the environment-defect marker — a mis-wrap here would
    // teach agents to exit blocked on their own fixable conduct.
    assert.doesNotMatch(r.stderr, /ENVIRONMENT DEFECT/);
    // NAME THE LEDGER AND ITS WINDOW. ledgerPath resolves three different files, so
    // one sentence used to cover "never read it", "read it in an earlier prompt
    // turn" and "a different agent read it" — and the conductor case reads as a
    // falsehood, because h13-clear-conductor wipes that ledger on every user
    // prompt. An agent's denial must say the ledger is the AGENT's own.
    assert.match(r.stderr, /Checked .*reads/, 'the ledger actually consulted is named');
    assert.match(r.stderr, /0 entries/, 'with how much evidence it held');
    assert.match(r.stderr, /this AGENT's own ledger/);
    assert.doesNotMatch(r.stderr, /CLEARS ON EVERY USER PROMPT/, 'the conductor window must not be claimed for an agent');

    // The CONDUCTOR's denial names its hash-expiry window (board 776d2b65) —
    // the fact that makes "I did read it" answerable: either never read, or
    // the file changed since.
    const conductorEdit = runHook(
      'h3-contract-gate.mjs',
      hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'feature.ts') } }),
      dir
    );
    assert.equal(conductorEdit.code, 2);
    assert.match(conductorEdit.stderr, /conductor-reads\.json/, 'the conductor ledger is named by path');
    assert.match(conductorEdit.stderr, /EXPIRES WHEN THE FILE CHANGES/);
    assert.match(conductorEdit.stderr, /modified since your last Read/);

    // with evidence -> allowed (absolute Windows path normalized)
    seedLedger(dir, 'r-1', 'a1', ['src/feature.ts']);
    r = edit(join(dir, 'src', 'feature.ts'));
    assert.equal(r.code, 0, oneLine(r.stderr));

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
    assert.equal(r.code, 0, oneLine(r.stderr));

    // outside the repository entirely
    r = edit('C:/elsewhere/x.ts');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /outside the repository/);

    // incidental_scope is allowed (with evidence)
    seedLedger(dir, 'r-1', 'a1', ['src/feature.ts', 'src/types.ts']);
    r = edit(join(dir, 'src', 'types.ts'));
    assert.equal(r.code, 0, oneLine(r.stderr));
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
    assert.equal(r.code, 0, oneLine(r.stderr));
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
    assert.match(r.stderr, /ENVIRONMENT DEFECT/);
    assert.match(r.stderr, /exit `blocked`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: a TORN read-evidence ledger denies as an ENVIRONMENT DEFECT, not ordinary misconduct (board c7b81456)', () => {
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    const lp = join(dir, '.sterling', 'runs', 'r-1', 'reads', 'agent-a1.json');
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, '{not json at all'); // torn: present, non-empty, unparseable
    const r = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'feature.ts') }, agent_id: 'a1' }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ENVIRONMENT DEFECT/);
    assert.match(r.stderr, /TORN/);
    assert.match(r.stderr, /not your conduct/i);
    // Self-healing state: the denial instructs the ONE repairing action (a
    // re-Read rebuilds the ledger from salvage) instead of do-not-retry, and
    // escalates to blocked only if the denial repeats (review F1, c7b81456).
    assert.match(r.stderr, /Read the target file now/);
    assert.match(r.stderr, /repairs the torn ledger/);
    assert.match(r.stderr, /exit `blocked`/);
  } finally {
    cleanup();
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
    assert.equal(r.code, 0, oneLine(r.stderr));
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

test('H5: a corrupt config denies (fail closed), never a voided frozen-test gate (F5 class)', () => {
  const corrupt = mkdtempSync(join(tmpdir(), 'sterling-h5c-'));
  mkdirSync(join(corrupt, '.sterling'), { recursive: true });
  writeFileSync(join(corrupt, '.sterling', 'config.json'), '{ not json');
  try {
    const r = runHook(
      'h5-frozen-tests.mjs',
      hookInput(corrupt, { tool_name: 'Edit', tool_input: { file_path: join(corrupt, 'tests', 'x.test.mjs') } }),
      corrupt
    );
    assert.equal(r.code, 2, 'a corrupt config denies (fail closed), never a non-blocking exit 1 that unfreezes tests');
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }
});

// Visible-repair half of decision frozen-test-repair-signatures-plus-visible-repair
// (knowledge_get 7a4c3fb6-dc23-4c2f-9369-d2592132f408; board a06e4a1c): H5's denial
// dropped a precondition it never actually checks ('during the fix loop' implies a
// run/phase state the hook never inspects) and never named the one route that IS
// sanctioned — conductor hand-repair with evidence recorded via test_repair (H5
// binds coder/debugger frontmatter only; the conductor is exempt by construction
// and was never denied by this hook in the first place). NOTE for conductor
// adjudication: the PRE-EXISTING test above ('H5: denies test-path edits per
// adapter test globs...', this file, asserts only /frozen/ and /tests-invalid/)
// does not pin 'during the fix loop' verbatim, so it does not conflict with this
// new assertion set — but it also does not yet assert the NEW required content
// (b)/(d) below, so it will need strengthening once the message ships to stop
// under-specifying the denial's fixed shape.
test('H5 denial (visible-repair, decision 7a4c3fb6): names test paths as frozen for pipeline agents, never claims a fix-loop precondition, keeps the tests-invalid route, and names the conductor test_repair route', () => {
  const { dir, cleanup } = makeProject();
  try {
    const edit = (p) => runHook('h5-frozen-tests.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: p } }), dir);
    const r = edit(join(dir, 'tests', 'feature.spec.ts'));
    assert.equal(r.code, 2);
    // (a) still names the freeze
    assert.match(r.stderr, /frozen/);
    // (b) states the WHO — frozen for pipeline agents — not an unchecked run-state claim
    assert.match(r.stderr, /pipeline agent/i, 'denial names test paths as frozen for pipeline agents');
    assert.doesNotMatch(r.stderr, /during the fix loop/, "the hook never checks run/phase state, so it must not claim this precondition");
    // (c) keeps the tests-invalid escape hatch
    assert.match(r.stderr, /tests-invalid/, 'keeps pointing at the typed escape hatch');
    assert.match(r.stderr, /evidence/i, '"exit tests-invalid with evidence" guidance survives');
    // (d) names the sanctioned repair route explicitly
    assert.match(r.stderr, /conductor/i, 'names the conductor as the one who repairs');
    assert.match(r.stderr, /test_repair|test-repair/, 'names the test_repair evidence route by name');
  } finally {
    cleanup();
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
    // Redirection on an allowed prefix is a write vector (`node --test > src/x.ts`
    // clobbers a path) — denied by the operator gate, not only swept by H17.
    r = bash('node --test > /tmp/evil.txt');
    assert.equal(r.code, 2, 'redirection on an allowed prefix is denied (H14 redirection gap fix)');
    assert.match(r.stderr, /redirection/);
    assert.equal(bash('node --test src/x.test.mjs > clobber.ts').code, 2, 'stdout redirect onto a repo path is denied');
    assert.equal(bash('node --test 2> err.log').code, 2, 'stderr redirect is denied too');
    assert.equal(bash('node --test >> append.txt').code, 2, 'append redirect is denied');
  } finally {
    cleanup();
  }
});

test('H14: standalone read-only grep/ls are allowed; chaining, redirection, find, and lookalikes stay denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const bash = (command) => runHook('h14-bash-allowlist.mjs', hookInput(dir, { tool_name: 'Bash', tool_input: { command } }), dir);
    assert.equal(bash('grep -rn "runCommandPrefixes" scripts/hooks').code, 0);
    assert.equal(bash('grep -l pattern src/a.ts src/b.ts').code, 0);
    assert.equal(bash('ls packages/schemas/src').code, 0);
    assert.equal(bash('ls').code, 0, 'bare ls is a complete read-only command');
    assert.equal(bash('grep foo | head').code, 2, 'grep cannot pipe (control operators)');
    let r = bash('grep -r secret . > exfil.txt');
    assert.equal(r.code, 2, 'redirection turns grep into a write — denied');
    r = bash('ls -la > listing.txt');
    assert.equal(r.code, 2, 'redirection turns ls into a write — denied');
    r = bash('find . -name "*.ts"');
    assert.equal(r.code, 2, 'find stays denied (-exec/-delete execute)');
    assert.match(r.stderr, /read-only search/, 'the denial teaches the grep/ls allowance');
    assert.equal(bash('lsof -i').code, 2, 'allowance needs a word boundary (lsof is not ls)');
    assert.equal(bash('grepx foo').code, 2, 'allowance needs a word boundary (grepx is not grep)');
  } finally {
    cleanup();
  }
});

test('H14: a MULTI-WORD quoted run-command prefix is still denied — genuinely unmatchable as one quoted token (decision 398adceb, board f49466f5)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const bash = (command) => runHook('h14-bash-allowlist.mjs', hookInput(dir, { tool_name: 'Bash', tool_input: { command } }), dir);
    const r = bash('"node --test" src/x.test.mjs');
    assert.equal(r.code, 2, 'a multi-word quoted span cannot smuggle a prefix past the allowlist — the allow surface is unchanged');
    assert.match(r.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/, 'the discriminator is named, not just the allowlist');
    assert.match(r.stderr, /Re-run it unquoted: 'node --test src\/x\.test\.mjs'/, 'and the working form is spelled out');
    // Both quoting instincts, not only double quotes.
    const single = bash("'node --test' src/x.test.mjs");
    assert.equal(single.code, 2);
    assert.match(single.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/, 'a single-quoted multi-word span hits the same trap and gets the same diagnosis');
    // The hint fires ONLY when quoting is the actual discriminator — an unrelated
    // denial must not acquire a misleading quoting explanation.
    const unrelated = bash('git push --force');
    assert.equal(unrelated.code, 2);
    assert.doesNotMatch(unrelated.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/, 'no quoting hint where dropping quotes would not have helped');
    const quotedButStillWrong = bash('"git" push');
    assert.equal(quotedButStillWrong.code, 2);
    assert.doesNotMatch(quotedButStillWrong.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/, 'quoted but not otherwise allowlisted gets no hint either');
  } finally {
    cleanup();
  }
});

test('H14: a quoted SINGLE-WORD first token now MATCHES for match purposes only — the executed command and every other branch are untouched (board f49466f5)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const bash = (command) => runHook('h14-bash-allowlist.mjs', hookInput(dir, { tool_name: 'Bash', tool_input: { command } }), dir);
    // '"node" --test …' where 'node --test …' is allowed: the quoted content is a
    // single word, so it strips for matching and passes.
    assert.equal(bash('"node" --test src/x.test.mjs').code, 0, 'a double-quoted single-word first token is allowed where the unquoted form is');
    assert.equal(bash("'node' --test src/x.test.mjs").code, 0, 'a single-quoted single-word first token is allowed too');
    // Smuggling shape: a quoted MULTI-WORD first token must NOT match — quoting
    // cannot compress an entire prefix (or more) into one opaque token.
    assert.equal(bash('"node --test" x').code, 2, 'a multi-word quoted first token is denied even though the unquoted equivalent would be allowed');
    // Smuggling shape: mismatched quotes are not stripped at all.
    const mismatched = bash('"node\' --test src/x.test.mjs');
    assert.equal(mismatched.code, 2, 'mismatched quotes are not stripped for matching');
    assert.doesNotMatch(mismatched.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/, 'mismatched quotes get no quoting diagnosis either — there is no clean unquoted form to offer');
    // Smuggling shape: quotes mid-token are untouched (the token does not START with a quote).
    assert.equal(bash('node"--test" src/x.test.mjs').code, 2, 'quotes appearing mid-token are not stripped');
  } finally {
    cleanup();
  }
});

test('H14: a space-bearing declared prefix carries the word-splitting caveat, so the unquoted advice cannot mislead', () => {
  // "Re-run it unquoted" is true about H14's matcher and can be false about the
  // outcome: the shell word-splits a path containing spaces. Which case applies
  // is undecidable from the config string, so the hook states the condition
  // rather than guessing (correctness review 2026-07-30).
  const spaced = {
    toolchains: [
      { adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['**/*.test.mjs'], run_commands: { test: 'C:/Program Files/nodejs/node.exe --test' } },
    ],
  };
  const { dir, cleanup } = makeProject({ config: spaced });
  try {
    const r = runHook(
      'h14-bash-allowlist.mjs',
      hookInput(dir, { tool_name: 'Bash', tool_input: { command: '"C:/Program Files/nodejs/node.exe --test" src/x.test.mjs' } }),
      dir
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /THE QUOTED FORM IS GENUINELY UNMATCHABLE/);
    assert.match(r.stderr, /CAVEAT before you retry/, 'the dead end is disclosed rather than papered over');
    assert.match(r.stderr, /word-split by the shell/, 'and the reason is named');
    assert.match(r.stderr, /NO working spelling here/, 'including that the command may be unrunnable outright');
    assert.match(r.stderr, /board f49466f5/, 'pointing at the open decision on accepting quoted forms');
  } finally {
    cleanup();
  }
});

test('H14: the word-splitting caveat is NOT attached to a space-free executable — no false alarm on the common case', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Declared prefix here is 'node --test': the space separates arguments, the
    // executable is one token, and the unquoted advice is unconditionally sound.
    const r = runHook(
      'h14-bash-allowlist.mjs',
      hookInput(dir, { tool_name: 'Bash', tool_input: { command: '"node --test" src/x.test.mjs' } }),
      dir
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Re-run it unquoted/);
    assert.match(r.stderr, /CAVEAT before you retry/, "'node --test' does contain a space, so the caveat is stated honestly rather than suppressed by a guess");
  } finally {
    cleanup();
  }
});

test('H14: a corrupt config denies (fail closed), never a voided allowlist (F5 class)', () => {
  const corrupt = mkdtempSync(join(tmpdir(), 'sterling-h14c-'));
  mkdirSync(join(corrupt, '.sterling'), { recursive: true });
  writeFileSync(join(corrupt, '.sterling', 'config.json'), '{ not json');
  try {
    const r = runHook(
      'h14-bash-allowlist.mjs',
      hookInput(corrupt, { tool_name: 'Bash', tool_input: { command: 'git push --force' } }),
      corrupt
    );
    assert.equal(r.code, 2, 'a corrupt config denies (fail closed), never a non-blocking exit 1 that runs arbitrary Bash');
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
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
    assert.equal(observed.code, 0, oneLine(observed.stderr));

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
  // Build into a TEMP dir — NEVER over hooks/, the live enforcement surface every
  // hook call of the running session loads from disk. Building in place meant
  // merely RUNNING this suite shipped whatever was in scripts/hooks/ live, and
  // made a mutation battery compile its own sabotage into the surface it was
  // testing (board 3e569411). The property pinned here — the EMITTED bundle
  // behaves like its source — is unchanged; only the output location is.
  const liveProbe = join(root, 'hooks', 'h5-frozen-tests.mjs');
  // MTIME, not bytes: on a clean tree an in-place rebuild emits byte-identical
  // output, so a content comparison would pass while the live surface was in
  // fact rewritten — the exact hollow pin decision cf863d84 warns about. The
  // mtime moves on every write, identical bytes or not. Tolerates an unbuilt
  // clone (no shipped bundle yet) rather than throwing before the cleanup.
  const liveBefore = existsSync(liveProbe) ? statSync(liveProbe).mtimeMs : null;
  const outDir = mkdtempSync(join(tmpdir(), 'sterling-hooks-build-'));
  let cleanup = () => {};
  try {
    let dir;
    ({ dir, cleanup } = makeProject());
    const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-hooks.mjs'), '--out-dir', outDir], { encoding: 'utf8', cwd: root, timeout: 120_000 });
    assert.equal(build.status, 0, oneLine(build.stderr));
    assert.equal(statSync(liveProbe).mtimeMs, liveBefore, 'the suite must not rebuild the LIVE hooks/ bundle');
    const bundled = join(outDir, 'h5-frozen-tests.mjs');
    assert.ok(existsSync(bundled));
    assert.ok(!readFileSync(bundled, 'utf8').includes("from '@sterling/"), 'no workspace imports at runtime');
    const r = spawnSync(process.execPath, [bundled], {
      input: JSON.stringify(hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'tests', 'x.test.mjs') } })),
      encoding: 'utf8',
      cwd: dir,
      timeout: 30_000,
    });
    assert.equal(r.status, 2, oneLine(r.stderr));
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
      const res = spawnSync(process.execPath, [join(outDir, file)], {
        input: JSON.stringify(hookInput(dir, { hook_event_name: event, ...benign[event] })),
        encoding: 'utf8',
        cwd: dir,
        timeout: 30_000,
        // STERLING_PLUGIN_ROOT is set EXPLICITLY because these bundles now live
        // in a tmpdir: h1's pluginRoot() resolves from import.meta.url and its
        // bounded 4-level walk finds no .claude-plugin above /tmp, so it would
        // return null and the smoke would exercise the plugin-root-absent
        // branch instead of the production shape (reviewer finding, 2026-08-23).
        // STERLING_CURRENCY_DISABLE then keeps the clone-currency probe from
        // fetching the real origin inside the test battery — which runs during
        // /sterling:update itself. Hermeticity by construction, not by this
        // machine's declared role.
        env: { ...process.env, STERLING_PLUGIN_ROOT: root, STERLING_CURRENCY_DISABLE: '1' },
      });
      assert.equal(res.status, 0, `${file} on benign ${event}: exit ${res.status} — ${oneLine(res.stderr)}`);
    }
  } finally {
    cleanup();
    rmSync(outDir, { recursive: true, force: true });
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

// SLICE 1 hardlink probe — copied in SHAPE from
// h17-read-blob-restore.test.mjs's HARDLINK_SKIP (T11). Two tmpdir() siblings
// so the probe (and every real test below that uses it) is same-device by
// construction; on this host the checkout may be drvfs while tmpdir() is
// ext4, so pairing a victim with the real checkout would fail EXDEV before
// the primitive is ever exercised — indistinguishable, from a bare exception,
// from "hard links aren't supported here". A genuine EXDEV during the probe
// itself (i.e. the two tmpdir() siblings are NOT same-device) is a broken
// fixture, not a skip, and must fail loudly rather than silently skip every
// test that depends on it.
const HARDLINK_SKIP = (() => {
  let outsideProbe;
  let targetProbe;
  try {
    outsideProbe = mkdtempSync(join(tmpdir(), 'sterling-enf-hlprobe-outside-'));
    targetProbe = mkdtempSync(join(tmpdir(), 'sterling-enf-hlprobe-target-'));
    const a = join(outsideProbe, 'a.txt');
    const b = join(targetProbe, 'b.txt');
    writeFileSync(a, 'x');
    try {
      linkSync(a, b);
    } catch (e) {
      if (e.code === 'EXDEV') {
        throw new Error(
          `BROKEN FIXTURE (not a skip): the outside-victim dir (${outsideProbe}) and the target tmpdir() shape (${targetProbe}) are on DIFFERENT devices — link() failed EXDEV. Both are meant to be tmpdir() siblings; fix the directory placement rather than letting this skip silently.`
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

// run git in `dir` (setup helper — never silently swallows a setup failure: P5)
function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
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
// ref). `activeRun:false` gives the L2 no-run posture. `amendments` seeds the run's
// scope_amendments (run r-1417: mid-run scope amendment consumer).
function makeGitProject({ activeRun = true, briefRef, config = CONFIG, amendments } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-'));
  const runId = 'r-h17-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // PIN LINE ENDINGS, or seven H17 tests fail on Windows and nowhere else.
  // A fresh repo INHERITS core.autocrlf from the user/system config, and
  // Git-for-Windows sets it true at SYSTEM level by default. The fixtures below
  // are written with \n, but git then stores them normalized and hands them back
  // CRLF on checkout — which is exactly what H17's restore path does — so the
  // byte-exact `readFileSync === original` assertions compare 'x;\r\n' to 'x;\n'
  // and fail. The defect is the harness's, not the hook's: this repo sets
  // autocrlf=false locally, so only the TEMP repos this helper creates inherit
  // the system value. A repo the test creates is a repo the test must configure.
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

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
      ...(amendments ? { scope_amendments: amendments } : {}),
    });
  }

  // Must mirror h17's projectTag(cwd) EXACTLY — sha256(realpath(cwd)).slice(0,16).
  // It did not: this was 'sterling-enforce-<runId>.json', a pre-projectTag name, so
  // the AC9b "corrupt baseline" test wrote garbage to a path the hook never reads and
  // passed on the ABSENT branch instead. Found 2026-07-30 while adding the
  // attribution tests; both AC9 assertions now pin their specific message so neither
  // can pass for the wrong reason again.
  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const baselinePath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.json`);
  const dirtyPath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.dirty.json`);
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
    rmSync(dirtyPath, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true });
  };
  return { dir, store, run, brief, runId, dbPath, baselinePath, dirtyPath, closeStore, cleanup };
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
    assert.equal(r.code, 2, `hooks/** tamper must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `out-of-blast-radius test edit must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `modified out-of-contract source must deny — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(other, 'utf8'), origOther, 'modified source restored via git checkout HEAD');

    // (b) UNTRACKED out-of-contract FILE → deleted
    const evilFile = join(dir, 'src', 'evil.mjs');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(evilFile, 'console.log("planted");\n');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `untracked out-of-contract file must deny — ${oneLine(r.stderr)}`);
    assert.equal(existsSync(evilFile), false, 'untracked out-of-contract file deleted');

    // (c) UNTRACKED out-of-contract DIR — git collapses to `?? src/evildir/` → removed recursively
    const evilDir = join(dir, 'src', 'evildir');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'a.ts'), 'x');
    writeFileSync(join(evilDir, 'b.ts'), 'y');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `untracked out-of-contract dir must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 0, `clean tree must allow — ${oneLine(r.stderr)}`);

    // an in-blast-radius edit + a new in-scope file: allowed AND left intact
    const feature = join(dir, 'src', 'feature.ts'); // in blast radius
    const editedFeature = readFileSync(feature, 'utf8') + '\n// legit in-scope edit\n';
    const newInScope = join(dir, 'src', 'new-file.ts'); // in blast radius (creation allowed)
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(feature, editedFeature);
    writeFileSync(newInScope, 'export const created = 1;\n');
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 0, `in-scope work must not be blocked — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 0, `conductor legitimately edits the enforcement surface — must allow (${oneLine(r.stderr)})`);
    assert.equal(readFileSync(hooksJson, 'utf8'), tampered, 'conductor edit NOT restored — proves the short-circuit before git');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC8 (v3.1 EXPANDED, addition arm RE-CUT 2026-08-27 per user ruling; RESTORE ARM
// INVERTED 2026-08-29 — Ruling D of decision 532a4383, refined by fac9a69b: the
// WHOLE (B) set moves to DETECT-AND-DENY, NO RESTORE, closing the two-call
// laundering bypass a call-window-only restore would leave open) — gitignored
//   enforcement writes caught via the (B) baseline;
//   agents/evil.md (new → DENIED + REPORTED, left ON DISK — deleting an unexpected
//     addition is irreversible and H17 cannot tell a malicious plant from a
//     legitimate file the conductor just created; the sweep is a detector, not
//     an eraser, so a real plant survives on disk until a human removes it),
//   .sterling/config.json (modified → DENIED, bytes LEFT EXACTLY AS THE COMMAND
//     WROTE THEM — restore-on-modify is RETIRED for the whole (B) set; there is
//     no longer a git-recoverable-baseline carve-out for a tracked/known (B) file),
//   .claude/settings.local.json (modified → DENIED, same no-restore rule — also
//     inverted from the prior restore-on-modify behaviour).
//   sterling.db change NOT flagged (unchanged — explicitly excluded from the (B)
//     set per decision fac9a69b / the h17 article).
//
// SPLIT INTO FRESH-FIXTURE ARMS 2026-08-29 — decision `b-surface-adoption-point-
// closes-with-an-incident-bound-taint-latch-not-a-persisted-manifest` (bcd2cc09),
// RULINGS 7-11. These four behaviours used to run SEQUENTIALLY inside ONE project
// fixture. Under the taint latch that is no longer a valid oracle: the FIRST arm's
// denial creates a durable latch at `.sterling/enforcement-taint.json`, and WHILE
// IT EXISTS every subsequent agent tool call is denied BEFORE execution — so arms
// 2 and 3 would be denied by the latch instead of by the no-restore rule they were
// written to check, and arm 4 (the excluded-DB control) could not observe its
// ALLOW at all. Each behaviour now owns a FRESH project dir with no inherited
// latch, and every existing byte-survival / denial-wording assertion is preserved
// verbatim. Also anti-pattern f1d66bef (an early assertion failure aborts the whole
// test and hides every later assertion) — the settings arm below carried a comment
// recording that exactly that had happened to it.
//
// The excluded-DB control is placed FIRST deliberately: it is the arm that must
// pass for the OPPOSITE reason (ALLOW), so a DENY in any arm below cannot be
// explained by "this fixture denies everything".
//
// The LAST test in this block pins the latch's cross-call consequence for these
// arms; the full latch ruling (set points, fail-closed shapes, clearance) is
// pinned in scripts/tests/h17-b-taint-latch.test.mjs.
// ---------------------------------------------------------------------------

// THE LATCH — decision bcd2cc09 Ruling 7: `.sterling/enforcement-taint.json`, a
// plain file, deliberately outside the sealed DB and outside BASELINE_GLOBS.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

test('H17 AC8-DB-CONTROL: a sterling.db change is NOT in the (B) set and is NOT flagged (the ALLOW control for every AC8 arm below)', { skip: GIT_SKIP }, () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    // --- sterling.db change is NOT in the (B) set and git is blind to it → NOT flagged ---
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    store.create(briefRecord()); // a legit store write mutates sterling.db between Pre and Post
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `a sterling.db change must NOT be flagged (${oneLine(r.stderr)})`);
    // Sabotage: add `.sterling/sterling.db` (or a `.sterling/**` catch-all) to the
    // (B) BASELINE_GLOBS → this ALLOW flips to a DENY, and every ordinary store
    // write during an agent call becomes an incident that latches the surface.
    assert.equal(existsSync(latchPath(dir)), false, 'and no taint latch is created by an ordinary, allowed call');
  } finally {
    cleanup();
  }
});

test('H17 AC8-ADDITION: a new gitignored .claude/agents file is DENIED + REPORTED and left ON DISK byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // --- .claude/agents/evil.md : NEW → DENIED, file SURVIVES byte-identical on disk ---
    const evilAgent = join(dir, '.claude', 'agents', 'evil.md');
    const legitAgent = join(dir, '.claude', 'agents', 'coder.md');
    const plantedBytes = Buffer.from('# smuggled agent (hooks stripped)\n');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(evilAgent, plantedBytes);
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `new gitignored agent file must deny — ${oneLine(r.stderr)}`);
    // Verdict carrier for this arm: SURVIVAL + BYTE-IDENTITY, not the exit code above.
    // Measured on this exact file: an exit-code-only assertion stayed GREEN even with
    // the survive-on-disk guard removed, because the old code deleted the file FIRST
    // and still denied (exit 2) afterward — same exit code, opposite disk outcome.
    // Do not "simplify" this arm back to an exit-code check.
    assert.ok(existsSync(evilAgent), 'unexpected addition must survive on disk (no delete)');
    // Sabotage: reintroduce the old unlink-on-addition call (or any code path that
    // removes evilAgent before/after denying) → this assertion goes red.
    assert.deepEqual(
      readFileSync(evilAgent),
      plantedBytes,
      'surviving file must be byte-identical to what was planted, not merely present'
    );
    // Sabotage: truncate, re-encode, or partially rewrite evilAgent instead of leaving
    // it untouched (e.g. write an empty placeholder in its place) → this assertion
    // goes red even though existsSync above would still pass.
    assert.doesNotMatch(
      oneLine(r.stderr),
      /reverted|removed/i,
      'denial message must not claim an action (revert/remove) that no longer happens'
    );
    // Sabotage: leave the old "restore to baseline-absent" / "reverted" wording in the
    // (B)-addition denial message path → this assertion goes red.
    assert.match(oneLine(r.stderr), /detect/i, 'denial message must say the addition was DETECTED');
    assert.match(oneLine(r.stderr), /left/i, 'denial message must say the file was LEFT in place / on disk');
    // Sabotage: drop the "detected and left in place" wording from the addition-denial
    // message (e.g. revert to a generic "denied" with no disposition stated) →
    // this assertion goes red.
    assert.ok(existsSync(legitAgent), 'a legit pre-existing agent file is left untouched');
  } finally {
    cleanup();
  }
});

test('H17 AC8-CONFIG: a modified .sterling/config.json is DENIED and left byte-identical to what the command wrote (no restore)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // --- .sterling/config.json : MODIFIED → DENIED, bytes LEFT AS WRITTEN (Ruling D: no restore) ---
    const configPath = join(dir, '.sterling', 'config.json');
    const origConfig = readFileSync(configPath, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    const hackedConfig = JSON.stringify({ ...CONFIG, HACKED: true });
    writeFileSync(configPath, hackedConfig);
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `modified gitignored config must deny — ${oneLine(r.stderr)}`);
    // Sabotage: reintroduce a restore-to-baseline write on this (B) arm (e.g. call
    // the old writeUnder-to-HEAD/baseline routine for .sterling/config.json before
    // returning) → this assertion goes red, because the bytes would revert to
    // origConfig instead of staying as the command wrote them.
    assert.equal(readFileSync(configPath, 'utf8'), hackedConfig, '.sterling/config.json is DENIED but left byte-identical to what the command wrote — never restored (Ruling D, decision 532a4383/fac9a69b)');
    assert.notEqual(readFileSync(configPath, 'utf8'), origConfig, 'and specifically NOT reverted to the pre-write baseline');
  } finally {
    cleanup();
  }
});

test('H17 AC8-SETTINGS: a modified .claude/settings.local.json is DENIED and left byte-identical to what the command wrote (no restore)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // --- .claude/settings.local.json (the GITIGNORED hook-disable file): MODIFIED →
    // DENIED, bytes LEFT AS WRITTEN (Ruling D: no restore). This arm used to sit
    // BEHIND the config.json arm inside one shared fixture and never ran once that
    // arm's first assertion aborted the chain (anti-pattern f1d66bef); it now owns
    // its own fresh fixture and reports its own verdict. settings.local.json is
    // named in the same (B) set as config.json in both 532a4383 and fac9a69b, so
    // the same no-restore rule applies. ---
    const settingsLocal = join(dir, '.claude', 'settings.local.json');
    const origSettings = readFileSync(settingsLocal, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    const hackedSettings = JSON.stringify({ hooks: 'DISABLED' });
    writeFileSync(settingsLocal, hackedSettings);
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 2, `gitignored settings.local.json write must deny — ${oneLine(r.stderr)}`);
    // Sabotage: reintroduce a restore-to-baseline write on this (B) arm → this
    // assertion goes red, because the bytes would revert to origSettings instead of
    // staying as the command wrote them.
    assert.equal(readFileSync(settingsLocal, 'utf8'), hackedSettings, 'settings.local.json is DENIED but left byte-identical to what the command wrote — never restored (Ruling D)');
    assert.notEqual(readFileSync(settingsLocal, 'utf8'), origSettings, 'and specifically NOT reverted to the pre-write baseline');
  } finally {
    cleanup();
  }
});

// The cross-call half of the AC8 arms above (decision bcd2cc09, RULINGS 7-11).
// Each arm above ends at its own denial; NONE of them shows what the next call
// sees. That gap IS the defect bcd2cc09 was ruled to close: the bytes are
// deliberately left on disk, so the NEXT call's Pre re-collected them as its own
// legitimate baseline and allowed — one denial bought a permanent edit to the
// agent GRANT DEFINITIONS. The latch closes it: while
// `.sterling/enforcement-taint.json` exists, EVERY subsequent agent tool call is
// denied BEFORE execution, and only a separate conductor reconciliation clears it
// (never an ordinary call, never the stamp producer).
//
// Lanes carry a tool_use_id here (`tu`), unlike the A1 arms above, so the two
// calls are genuinely distinct windows rather than the degraded-loud fallback.
test('H17 AC8-LATCH: after a latching (B) arm, the NEXT call is DENIED AT PRE by the taint latch — the adoption point is closed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const configPath = join(dir, '.sterling', 'config.json');
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before call N');

    // CONTROL, PLACED FIRST, passing for the OPPOSITE reason: on this same
    // fixture with no incident on record, Pre ALLOWS. Without it, call N+1's
    // denial below could equally be explained by "this fixture/mode denies every
    // Pre" — a green that carries no evidence.
    const L1 = tu('ac8-latch-calln');
    const pre1 = h17(dir, 'PreToolUse', L1);
    assert.notEqual(pre1.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre1.code, 0, `CONTROL: with no incident on record, Pre must ALLOW — actual ${pre1.code}, stderr: ${oneLine(pre1.stderr)}`);

    // --- call N: the config.json arm again, this time only as the LATCHING event ---
    const hackedConfig = JSON.stringify({ ...CONFIG, HACKED: true });
    writeFileSync(configPath, hackedConfig);
    const r1 = h17(dir, 'PostToolUse', L1);
    assert.notEqual(r1.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r1.code, 2, `call N: the unattested (B) modify must deny — actual ${r1.code}, stderr: ${oneLine(r1.stderr)}`);
    // Sabotage: remove the latch-creation call from the (B)-denial branch (leaving
    // the denial itself intact) → this assertion flips from true to false.
    assert.equal(existsSync(latchPath(dir)), true, 'call N: the denial creates the durable taint latch at .sterling/enforcement-taint.json');

    // --- call N+1: a different window that changes NOTHING of its own ---
    const L2 = tu('ac8-latch-calln1');
    const pre2 = h17(dir, 'PreToolUse', L2);
    assert.notEqual(pre2.code, 1, 'a security gate never fails with a non-blocking exit 1');
    // Sabotage: with the latch still created, drop the latch consult at Pre (the
    // "deny before execution while latched" check) → this flips from 2 back to 0,
    // reproducing the adoption bug exactly while the latch-creation guard above
    // stays green. THIS assertion is the one that carries the verdict.
    assert.equal(
      pre2.code,
      2,
      `THE ADOPTION CLOSURE: while the latch stands, the NEXT agent call is denied BEFORE execution even though nothing changed in its own window — actual ${pre2.code}, stderr: ${oneLine(pre2.stderr)}`
    );
    assert.match(oneLine(pre2.stderr), /taint|latch/i, 'the denial names the ONGOING taint, not a fresh in-window violation (there is none in this window)');

    // Deliberately NO Post for call N+1: a denied Pre means the command never ran,
    // so simulating its execution would assert against a state production cannot reach.
    assert.equal(readFileSync(configPath, 'utf8'), hackedConfig, "the (B) bytes still sit exactly as call N's command wrote them — never restored, and never adopted as a fresh baseline");
    assert.equal(existsSync(latchPath(dir)), true, 'an ordinary call never clears the latch — only a separate conductor reconciliation does (Rulings 3/5/10)');
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
    assert.equal(r.code, 2, `missing baseline during active run → deny — ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /absent at Post/, 'and denies on the ABSENT branch specifically, not merely with exit 2');
  } finally {
    cleanup();
  }
});

test('H17 AC9b: corrupt/unparseable baseline → deny, not exit 1', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baselinePath, dirtyPath } = makeGitProject();
  try {
    writeFileSync(baselinePath, '{ this is : not valid json ,,, ');
    writeFileSync(dirtyPath, '[]'); // present and valid, so the CORRUPT branch is what fires
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'must not fail open on an unparseable baseline');
    assert.equal(r.code, 2, `corrupt baseline → deny — ${oneLine(r.stderr)}`);
    // Pinning the branch. Before the fixture's baselinePath was corrected it wrote
    // to a pre-projectTag filename the hook never reads, so the baseline was ABSENT
    // and the deny came from that branch (h17: "absent at Post") — under which this
    // assertion cannot match, which is what makes it a real guard rather than a
    // restatement of the exit code.
    assert.match(r.stderr, /corrupt\/unparseable/, 'and denies on the CORRUPT branch specifically');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Attribution (decision f76d7c5c): the (A) branch must distinguish writes made BY
// the audited command from state that was already dirty before it ran. Reverting
// the latter destroyed a conductor's uncommitted enforcement-surface work and
// reported it as the agent's.
//
// THE DENIAL HALF OF THAT RULING CHANGED — decision h17-pre-state-snapshot-
// closes-false-denial-not-the-restore-hole (knowledge_get
// 7021526c-09b0-4ec2-96eb-fd59cf52c0ad), board 0b848342 finding (4). It used to
// be that ANY enforcement-surface path dirty at Pre denied the whole Bash
// result, on the warrant that "the enforcement surface cannot be verified while
// it is dirty". That warrant held only because Pre recorded PATHS ONLY, so Post
// could not tell whether the audited command had touched the path — three
// read-only `grep` dispatches were destroyed in one session by a DIFFERENT
// lane's committed rebuild. Pre now snapshots per-path STATE (existence, file
// TYPE, MODE, symlink TARGET via readlink, and the INDEX entry: stage, mode,
// blob OID), keyed per Bash call by sha256(tool_use_id), and Post compares it:
//   * pre-dirty, UNCHANGED at Post -> NO deny. Verified by OBSERVATION; no
//     stamp is consulted or needed, because decision 6e132e19's attestation is
//     not causally relevant to a path the guard can compare for itself.
//   * pre-dirty, CHANGED at Post   -> consult the stamp FRESH and hash the
//     CURRENT state: an exact match is a conductor attestation and ALLOWS,
//     otherwise DENY (decision 7021526c v2 settling this against 4d9b76e8,
//     whose rule is GENERAL and not confined to the clean-at-Pre branch — a
//     stamp can be written only by a deliberate conductor-run CLI and never
//     from a Bash-invoked rebuild, 6e132e19, so matching current bytes mean the
//     change is conductor-attested and denying it would punish the conductor
//     for its own attested edit). Either way still NOT restored: the pre-image
//     restore is deliberately out of scope (board 0b848342 finding 1), because
//     restoring would clobber a concurrent lane's legitimate write, so that
//     hole stays open and accepted. The attested arm is pinned in
//     h17-pre-state-snapshot.test.mjs (PIN-STAMP-ON-CHANGED-PREDIRT).
//   * clean at Pre, dirty at Post  -> UNCHANGED behaviour: fresh-stamp check
//     first (decision 4d9b76e8), else restore to HEAD and deny.
//   * no usable tool_use_id        -> DEGRADED-LOUD FALLBACK: the OLD blanket
//     pre-existing denial, saying so. Never a silent per-run key.
//   * AC9 fail-closed is retained IN FULL: a missing/corrupt snapshot record,
//     an unsupported file type, an lstat/git/index error, or any unexpected
//     error DENIES (exit 2), never a non-blocking exit 1.
// The never-reverted half of f76d7c5c and the false-attribution fix it was
// written for are both untouched. The four bytes-only escapes (mode flip,
// regular-file->symlink with identical bytes, symlink retarget, staged-index-
// only change), the per-call keying race and the degraded-loud fallback are
// pinned in scripts/tests/h17-pre-state-snapshot.test.mjs.
// ---------------------------------------------------------------------------

// One Bash call = one tool_use_id, carried by BOTH its Pre and its Post; two
// lanes carry different ones. Passed explicitly per test rather than baked into
// the shared h17() helper, so every OTHER H17 test above keeps exercising the
// no-tool_use_id degraded path exactly as it does today.
function tu(tag) {
  return { ...A1, tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 12)}` };
}

test('H17: a PRE-EXISTING dirty hooks/ file that is UNCHANGED across the window no longer denies — it is VERIFIED, and the uncommitted work survives', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // The conductor's own uncommitted work — e.g. a mid-run bundle rebuild. NOTE:
    // this is not conductor-exclusive at HEAD — the coder's allowlist admits any
    // declared toolchain run_commands entry, and this repo's .sterling/config.json
    // declares build_hooks: "npm run build:hooks" inside run_commands, so a
    // coder-run rebuild is equally plausible. Under the old ruling this alone
    // denied every parallel lane, including lanes running read-only commands.
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// conductor rebuild, not yet committed\n');
    const conductorBytes = readFileSync(bundle, 'utf8');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'PRECONDITION: no stamp — the allow must come from observation, not attestation');

    const L = tu('predirty-unchanged');
    h17(dir, 'PreToolUse', L); // Pre records this path's STATE, not just its name
    const r = h17(dir, 'PostToolUse', L); // the command wrote nothing

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `an UNCHANGED pre-dirty enforcement path is verifiable and must not deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), conductorBytes, 'THE POINT, unchanged from before: the uncommitted work survives');
  } finally {
    cleanup();
  }
});

test('H17: a write made DURING the command is still reverted and attributed — the gate is not weakened', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const committed = readFileSync(bundle, 'utf8');

    h17(dir, 'PreToolUse', A1); // clean at Pre
    writeFileSync(bundle, '// tampered by the agent mid-command\n'); // the bypass H17 exists to catch
    const r = h17(dir, 'PostToolUse', A1);

    assert.equal(r.code, 2);
    assert.match(r.stderr, /BY THIS COMMAND/, 'attributed to the command that made it');
    assert.match(r.stderr, /hooks\/h3-contract-gate\.mjs/);
    assert.match(r.stderr, /only the last is amendable by scope/, 'and names which of the three predicates can be amended');
    assert.equal(readFileSync(bundle, 'utf8'), committed, 'reverted to HEAD');
  } finally {
    cleanup();
  }
});

test('H17: a missing attribution record fails CLOSED — never silently unattributed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baselinePath, dirtyPath } = makeGitProject();
  try {
    h17(dir, 'PreToolUse', A1);
    assert.ok(existsSync(dirtyPath), 'Pre writes the attribution record beside the baseline');
    rmSync(dirtyPath, { force: true }); // e.g. a Pre written by an older bundle
    assert.ok(existsSync(baselinePath), 'the baseline itself is still present, isolating the new branch');

    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, 'unverifiable attribution denies rather than guessing');
    assert.match(r.stderr, /attribution record/);
    assert.match(r.stderr, /failing closed/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE ENFORCEMENT STAMP (decision h17-enforcement-stamp-conductor-attested-dirt,
// knowledge_get 6e132e19-0da1-47c2-9fa5-710bc7365014): a CONDUCTOR-run stamp
// (scripts/enforcement-stamp.mjs -> .sterling/transient/enforcement-stamp.json)
// records, for each currently-dirty enforcement path, the sha256 of its bytes at
// stamp time, so conductor-attested work-in-flight stops blocking agent Bash.
//
// WHERE THE STAMP STILL DECIDES, AND WHERE IT NO LONGER DOES. Since decision
// h17-pre-state-snapshot-closes-false-denial-not-the-restore-hole (7021526c) the
// stamp is NOT causally relevant to an UNCHANGED pre-existing dirty path: that
// path is allowed by OBSERVATION, whatever any stamp says — so "a fresh stamp
// allows unchanged pre-dirt" has ceased to be a distinct behaviour and is
// deliberately NOT pinned as one anywhere (a test asserting it would pass while
// pinning nothing: exactly the hollow-test trap board 5402a024 records). It
// remains causally DECISIVE the moment the state CHANGED — that arm consults it
// fresh against the CURRENT state and allows on an exact match (7021526c v2;
// pinned in h17-pre-state-snapshot.test.mjs). Irrelevant on one arm, decisive on
// the other, one order of operations, no contradiction. The tests immediately
// below therefore pin the surviving, load-bearing halves:
//   * a stamp of ANY shape — matching, mismatched, corrupt, non-array, absent —
//     is irrelevant to an UNCHANGED pre-dirty path, which allows regardless
//     (under the OLD ruling a mismatched/corrupt/absent stamp DENIED, so this is
//     a real behavioural flip, not a restatement). The claim is scoped to the
//     UNCHANGED arm deliberately: on a CHANGED pre-dirty path the same shapes
//     are decisive, because a stamp that cannot be parsed or matched is not an
//     attestation;
//   * a stamp that is corrupt or the wrong shape still grants NO exemption where
//     an exemption would actually matter — a CLEAN-at-Pre in-window change,
//     which is restored to HEAD and denied (decision 4d9b76e8's arm, untouched
//     by this ruling);
//   * existence is a state term in both directions (deleted in-window; absent
//     at Pre and recreated in-window), which is what the old deleted:true
//     stamp-entry test was reaching for.
//
// EXPECTED FAILURE TODAY: every "must now ALLOW" assertion below fires against
// the current always-deny-while-dirty behaviour (actual 2, expected 0). The
// "must still DENY" tests are boundary/regression guards that already hold and
// must keep holding. The two standalone scripts/enforcement-stamp.mjs CLI tests
// are untouched by this ruling — their posture is whatever it already was.
// ---------------------------------------------------------------------------

function runStampCli(dir) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'enforcement-stamp.mjs')], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

// INVERTED 2026-08-29 by decision fac9a69b (Ruling 1, refining Ruling D of
// 532a4383): the fixture's (B) set — .claude/agents/coder.md,
// .claude/settings.local.json, .sterling/config.json — is gitignored, so git
// itself never reports it dirty; but Ruling 1 makes the stamp PRODUCER
// enumerate the (B) family explicitly, independent of git status, so those
// paths are ALWAYS attestable. A git-clean tracked tree (hooks/ untouched
// since the init commit) therefore no longer means "nothing to attest" — the
// (B) set alone gives the CLI something to stamp. This test used to assert the
// opposite; it now asserts the (B) paths ARE attested.
test('enforcement-stamp.mjs: a git-clean tracked tree still attests the always-enumerated (B) baseline set — never "nothing to attest"', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const r = runStampCli(dir);
    // Sabotage: short-circuit the (B)-set enumeration in scripts/enforcement-stamp.mjs
    // (e.g. make its path-listing function return [] unconditionally, or gate its
    // call site behind `if (false)`) → the CLI falls back to git-dirty-tracked-paths
    // only, finds none on this hooks-clean fixture, and this assertion goes red
    // (status nonzero again, "nothing to attest").
    assert.equal(r.status, 0, `the (B) set is always attestable, so the CLI must succeed even with hooks/ git-clean — ${oneLine(r.stderr)}`);
    const stampPath = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
    assert.ok(existsSync(stampPath), 'a stamp file IS written — the (B) set alone gives it something to attest');
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    const byPath = Object.fromEntries(stamp.map((e) => [e.path, e.sha256]));
    // Sabotage: hash a placeholder/empty buffer instead of the (B) path's actual
    // current bytes in the (B)-enumeration arm → any one of these three equalities
    // goes red while status/existence stay green.
    assert.equal(
      byPath['.claude/agents/coder.md'],
      createHash('sha256').update(readFileSync(join(dir, '.claude', 'agents', 'coder.md'))).digest('hex'),
      'the (B) agents file is attested with its current bytes even though git never saw it as dirty'
    );
    assert.equal(
      byPath['.claude/settings.local.json'],
      createHash('sha256').update(readFileSync(join(dir, '.claude', 'settings.local.json'))).digest('hex'),
      'the (B) settings.local.json is attested'
    );
    assert.equal(
      byPath['.sterling/config.json'],
      createHash('sha256').update(readFileSync(join(dir, '.sterling', 'config.json'))).digest('hex'),
      'the (B) config.json is attested'
    );
    assert.equal(byPath['.sterling/sterling.db'], undefined, 'sterling.db is explicitly excluded from the (B) set and must never be stamped');
    assert.equal(
      Object.keys(byPath).filter((p) => p.startsWith('hooks/')).length,
      0,
      'hooks/ is git-clean and unchanged, so no hooks/ path is stamped — only the (B) set is'
    );
  } finally {
    cleanup();
  }
});

// Repaired 2026-08-29 (decision fac9a69b, Ruling 1): the stamp now ALWAYS carries
// the (B) set (.claude/agents/coder.md, .claude/settings.local.json,
// .sterling/config.json) alongside whatever is git-dirty, so the count is 4 after
// the first run, not 1. Membership is asserted as the exact SET of paths rather
// than a bare length — a bare `.length === 4` would stay green even if the wrong
// four paths showed up (e.g. a duplicate hooks/ entry instead of a missing (B)
// path), which is exactly the failure mode a length-only pin cannot catch.
test('enforcement-stamp.mjs: stamps every dirty hooks/ path with the sha256 of its CURRENT bytes plus the always-enumerated (B) set, and a re-run overwrites rather than merges', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// first dirty content\n');
    let r = runStampCli(dir);
    assert.equal(r.status, 0, `stamp CLI must succeed while hooks/ is dirty: ${oneLine(r.stderr)}`);
    const stampPath = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
    let stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    let paths = stamp.map((e) => e.path).sort();
    // Sabotage: comment out or gate off the (B)-enumeration call in
    // scripts/enforcement-stamp.mjs → the three (B) paths disappear from this list
    // and this assertion goes red (actual would be ['hooks/h3-contract-gate.mjs']).
    assert.deepEqual(
      paths,
      ['.claude/agents/coder.md', '.claude/settings.local.json', '.sterling/config.json', 'hooks/h3-contract-gate.mjs'].sort(),
      'stamp lists exactly the one dirty hooks/ path plus the three always-attested (B) paths — never more, never fewer'
    );
    const byPath0 = Object.fromEntries(stamp.map((e) => [e.path, e]));
    assert.equal(byPath0['hooks/h3-contract-gate.mjs'].sha256, createHash('sha256').update(readFileSync(bundle)).digest('hex'));
    assert.ok(typeof byPath0['hooks/h3-contract-gate.mjs'].at === 'string' && byPath0['hooks/h3-contract-gate.mjs'].at.length > 0);

    // further drift + a second dirty path: re-running OVERWRITES with the fresh
    // set, never appends the stale entry alongside the new ones
    writeFileSync(bundle, '// SECOND, different dirty content\n');
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [] }, TAMPERED: true }));
    r = runStampCli(dir);
    assert.equal(r.status, 0, oneLine(r.stderr));
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    // PREDICTION, not yet observed: this section sat behind the `stamp.length === 1`
    // abort above and never actually ran under the old suite. By the same Ruling 1
    // logic this second run's set should be BOTH now-dirty hooks/ paths PLUS the
    // same three always-attested (B) paths = 5 members, not 2. Confirm on the real
    // run; if it disagrees this is a fresh finding, not a rubber-stamped repair.
    paths = stamp.map((e) => e.path).sort();
    assert.deepEqual(
      paths,
      ['.claude/agents/coder.md', '.claude/settings.local.json', '.sterling/config.json', 'hooks/h3-contract-gate.mjs', 'hooks/hooks.json'].sort(),
      'the fresh stamp lists both currently-dirty hooks/ paths plus the three always-attested (B) paths, not appended to the stale first-run set'
    );
    const byPath = Object.fromEntries(stamp.map((e) => [e.path, e.sha256]));
    assert.equal(byPath['hooks/h3-contract-gate.mjs'], createHash('sha256').update(readFileSync(bundle)).digest('hex'), "the NEW bytes are hashed, not the first stamp's stale hash");
    assert.equal(byPath['hooks/hooks.json'], createHash('sha256').update(readFileSync(hooksJson)).digest('hex'));
  } finally {
    cleanup();
  }
});

// =========================================================================
// SLICE 1 — enforcement-stamp.mjs PRODUCER TRUNCATE-IN-PLACE HARDLINK CLOBBER
// (conductor-verified live defect, found by an outside-family Codex consult;
// same class as the deleted (B)-restore primitive `writeUnder`, whose
// truncate-in-place hardlink clobber is pinned above at H17 T11 in
// h17-read-blob-restore.test.mjs).
//
// enforcement-stamp.mjs:296 classifies the stamp target path via
// classifyPathComponents, accepting kind 'file' or 'absent'; :303 then calls
// plain `writeFileSync(stampPath, JSON.stringify(stamp))`. A HARDLINK IS A
// REGULAR FILE TO lstat, so the classify check — built to catch a SYMLINK at
// the stamp path — does not catch a hardlink. If an agent plants a hardlink
// at `.sterling/transient/enforcement-stamp.json` pointing at any other file
// on the filesystem, the PRODUCER'S OWN writeFileSync truncates and
// overwrites that shared inode with stamp JSON — the conductor's own
// attestation tool, run trusted, clobbers a victim file it was never told
// about.
//
// CONTROL (placed first, NO producer involved): reproduces the exact
// primitive the producer uses at :303 — a plain `writeFileSync` on an
// EXISTING hardlinked leaf, no O_EXCL, no unlink-first — and proves it
// actually clobbers the linked outside file ON THIS HOST. Without this
// control a green TREATMENT result below is unfalsifiable: it would pass
// identically if hard links simply don't work on this filesystem/mount
// (mirrors T11's CONTROL rationale in h17-read-blob-restore.test.mjs:825-830).
//
// TREATMENT drives the REAL producer CLI end-to-end (spawnSync, same
// `runStampCli` used by the two sibling CLI tests above) against a fixture
// with a dirty (B) surface (makeGitProject already seeds
// .claude/agents/coder.md, .claude/settings.local.json, .sterling/config.json
// — see the "always-enumerated (B) baseline set" test above), plants the
// hardlink, and asserts the SAFETY PROPERTY rather than one specific
// implementation shape: either the victim's bytes survive byte-for-byte and
// the stamp path is no longer the same inode as the victim (unlink-and-create
// or temp-file-plus-rename), OR the producer refuses outright and leaves the
// victim untouched. Never asserts on exit code alone.
//
// SABOTAGE (to re-redden after the fix lands): in scripts/enforcement-stamp.mjs,
// change the stamp-writing line from an unlink-and-create (or
// temp-file-plus-rename) shape back to a bare
// `writeFileSync(stampPath, JSON.stringify(stamp))` on the classified target
// — i.e. revert to writing directly at the existing path without first
// removing/replacing the directory entry. That flips both TREATMENT
// assertions red: the victim's bytes become the stamp JSON instead of
// `VICTIM_BYTES`, and the victim path keeps sharing the stamp path's inode
// (nlink stays >= 2, same ino).
// =========================================================================

test('SLICE1 CONTROL: on this host, writeFileSync on a hardlinked leaf really does clobber the linked outside file (no producer involved)', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-enf-s1control-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-enf-s1control-outside-'));
  try {
    const outsideFile = join(outsideDir, 'victim.bin');
    const victimBytes = Buffer.from('SLICE1-VICTIM-BYTES-MUST-SURVIVE\n');
    writeFileSync(outsideFile, victimBytes);

    const leaf = join(probeDir, 'enforcement-stamp.json');
    linkSync(outsideFile, leaf);

    // exact primitive shape used at enforcement-stamp.mjs:303 — a plain
    // writeFileSync on the existing (hardlinked) leaf, no unlink first.
    writeFileSync(leaf, JSON.stringify([{ path: 'irrelevant', sha256: 'deadbeef' }]));

    const after = readFileSync(outsideFile);
    assert.ok(
      !after.equals(victimBytes),
      'CONTROL: writeFileSync on a hardlinked leaf must actually change the OUTSIDE file bytes on this host, or the TREATMENT test below proves nothing about the fix defending against it'
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('SLICE1: enforcement-stamp.mjs producer does not clobber a victim file reached via a hardlink planted at the stamp path', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject(); // dirty (B) surface already seeded — something to attest
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-enf-s1-outside-'));
  try {
    const victimFile = join(outsideDir, 'victim.bin');
    const victimBytes = Buffer.from('SLICE1-VICTIM-BYTES-MUST-SURVIVE\n');
    writeFileSync(victimFile, victimBytes);

    const stampPath = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
    mkdirSync(dirname(stampPath), { recursive: true });
    linkSync(victimFile, stampPath); // plant the hardlink AT the stamp path

    const preVictimIno = statSync(victimFile).ino;
    assert.equal(statSync(stampPath).ino, preVictimIno, 'PRECONDITION: the stamp path and the victim share one inode before the producer runs');

    const r = runStampCli(dir);

    // never assert on exit code alone — the safety property is byte survival,
    // whether the producer proceeds (exit 0) or refuses outright (nonzero).
    assert.deepEqual(
      readFileSync(victimFile),
      victimBytes,
      `SLICE1: THE LOAD-BEARING PROPERTY — the victim file's bytes must be UNTOUCHED after the producer runs; a truncate-in-place stamp write would have overwritten this shared inode with stamp JSON — producer exit ${r.status}, stderr: ${oneLine(r.stderr)}`
    );

    // acceptable fix shapes: (a) unlink-and-recreate / temp-file-plus-rename,
    // so the victim no longer shares an inode with whatever now sits at the
    // stamp path (even if the producer still wrote a stamp there); or
    // (b) the producer refused outright and never touched the stamp path at
    // all, in which case the hardlink itself still exists and nlink stays 2
    // — but the bytes assertion above already proves no clobber happened
    // either way. Assert the disjunction explicitly so a fix that DELETES the
    // hardlink without writing anything also passes.
    const stampStillLinkedToVictim = existsSync(stampPath) && statSync(stampPath).ino === preVictimIno && statSync(victimFile).nlink >= 2;
    assert.ok(
      !stampStillLinkedToVictim || r.status !== 0,
      'SLICE1: if the producer reports success (exit 0), the stamp path must no longer be the same inode as the victim — writing "successfully" while still sharing the victim inode means the write went through the hardlink'
    );
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    cleanup();
  }
});

// Was: "a stamp matching every dirty hooks/ path's CURRENT bytes lets the
// command proceed". That behaviour survives but has stopped being a behaviour OF
// THE STAMP — an unchanged pre-dirty path allows whether or not any stamp exists
// — so pinning the matching-stamp case here would pin nothing. What IS newly
// pinnable, and what the old ruling got the other way round, is the negative: a
// stamp that does NOT match, cannot be parsed, or is the wrong shape used to
// force the denial, and now cannot, because the guard no longer needs the
// attestation for a path it can compare itself.
//
// EXPECTED FAILURE SHAPE (RED): all three arms fire on `assert.equal(r.code, 0)`
// with actual 2 — today any pre-dirty enforcement path denies, and specifically
// these three stamp shapes are today's "no exemption" cases.
//
// CATCHES SABOTAGE: equality forced to always-UNEQUAL (`if (false) continue`),
// and any implementation that keeps consulting the stamp before deciding an
// unchanged pre-dirty path (all three arms would then deny again).
test('H17 pre-state: a MISMATCHED, CORRUPT or NON-ARRAY stamp is irrelevant to an UNCHANGED pre-dirty path — it allows regardless', { skip: GIT_SKIP }, () => {
  const cases = [
    ['mismatched hash', () => JSON.stringify([{ path: 'hooks/h3-contract-gate.mjs', sha256: createHash('sha256').update('completely different bytes').digest('hex'), at: NOW }])],
    ['corrupt json', () => '{ not json at all'],
    ['non-array object', () => JSON.stringify({ path: 'hooks/h3-contract-gate.mjs', sha256: 'deadbeef' })],
  ];
  for (const [label, body] of cases) {
    const { dir, cleanup } = makeGitProject();
    try {
      const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
      writeFileSync(bundle, '// conductor rebuild, not yet committed\n');
      const conductorBytes = readFileSync(bundle, 'utf8');
      const stamp = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
      mkdirSync(dirname(stamp), { recursive: true });
      writeFileSync(stamp, body());

      const L = tu('stampshape');
      h17(dir, 'PreToolUse', L);
      const r = h17(dir, 'PostToolUse', L); // the command wrote nothing

      assert.notEqual(r.code, 1, `[${label}] a security gate never fails with a non-blocking exit 1`);
      assert.equal(r.code, 0, `[${label}] an unchanged pre-dirty path is verified by observation, so this stamp cannot make it deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.equal(readFileSync(bundle, 'utf8'), conductorBytes, `[${label}] and the uncommitted work survives`);
    } finally {
      cleanup();
    }
  }
});

test('H17 stamp fix: the normal write-sweep still catches a tamper made DURING the command even with a matching stamp for the pre-existing dirt', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// conductor rebuild, not yet committed\n');
    assert.equal(runStampCli(dir).status, 0);

    h17(dir, 'PreToolUse', A1);
    // the agent's own command ALSO tampers an out-of-contract source file — the
    // stamp exempts only the pre-attested hooks/ dirt, never widens the sweep.
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 999; // tampered\n');
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, 'the stamp narrows the enforcement-dirty exemption; it never widens the normal write-sweep');
  } finally {
    cleanup();
  }
});

// Was: "a dirty path MISSING from the stamp still denies". The stamp's
// all-or-nothing shape over the whole pre-existing set was one of the reasons it
// did not prevent the measured cost (decision 7021526c, rejected alternative 4).
// The comparison replacing it is PER PATH, and this test pins that granularity
// with exit codes rather than message text: the same two pre-dirty paths, two
// windows — nothing changed, then one of them changed.
//
// EXPECTED FAILURE SHAPE (RED): window 1 fires on `assert.equal(r.code, 0)` with
// actual 2 (today any pre-dirty path denies). Window 2 is expected green today
// but for the wrong reason, and its bytes assertions are what keep it honest.
//
// CATCHES SABOTAGE: always-UNEQUAL (window 1 denies -> red) AND always-EQUAL
// (window 2 allows -> red) — the only test here that catches both directions on
// its own, plus any regression to all-or-nothing set semantics.
test('H17 pre-state: the comparison is PER PATH — two pre-dirty paths both unchanged allow; one of them changing denies while the other is untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    writeFileSync(bundle, '// dirty #1, uncommitted\n');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [] }, rebuilt: true }, null, 2) + '\n');
    const bundleBytes = readFileSync(bundle, 'utf8');

    // WINDOW 1 — neither path changes inside the window
    const L1 = tu('perpath-clean');
    h17(dir, 'PreToolUse', L1);
    let r = h17(dir, 'PostToolUse', L1);
    assert.equal(r.code, 0, `two UNCHANGED pre-dirty paths must not deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);

    // WINDOW 2 — exactly ONE of the two changes inside the window
    const L2 = tu('perpath-one');
    h17(dir, 'PreToolUse', L2);
    const tampered = JSON.stringify({ hooks: {}, TAMPERED: true });
    writeFileSync(hooksJson, tampered);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');
    r = h17(dir, 'PostToolUse', L2);

    assert.equal(r.code, 2, `one changed pre-dirty path must deny — ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /hooks\.json/, 'the deny names the path that changed');
    assert.equal(readFileSync(hooksJson, 'utf8'), tampered, 'the changed path is denied but NOT restored (the pre-image restore is a deferred slice)');
    assert.equal(readFileSync(bundle, 'utf8'), bundleBytes, "the OTHER lane's untouched pre-dirty bundle is unaffected");
  } finally {
    cleanup();
  }
});

// Was: "bytes drifted since stamping still denies". That drift happened BEFORE
// Pre, so it is now ordinary pre-existing dirt and the case is covered by the
// stamp-shape test above. This slot keeps the "falls back to the existing
// denial" subject and moves it to the one condition that still triggers it:
// NO USABLE tool_use_id. The field is read by no hook in this repo today and is
// attested only in docs/historical/PROBES.md:45, so its absence must degrade
// LOUDLY to the old blanket pre-existing denial — never silently to a per-run
// key, which would reopen the false-allow race decision 7021526c documents.
// Note this test deliberately uses the shared h17()/A1 helpers, which send NO
// tool_use_id — the same invocation every older H17 test above uses.
//
// EXPECTED FAILURE SHAPE: the deny and the PRE-EXISTING block are expected GREEN
// today (this IS today's behaviour). The RED assertion is
// `assert.match(r.stderr, /tool_use_id/)`: today's message has no notion of the
// field, so no such text is produced.
//
// CATCHES SABOTAGE: a silent fall back to a run-scoped key — this unchanged
// pre-dirty path would then be ALLOWED, firing the code assertion — and a
// fallback that degrades without disclosing why, firing the message assertion.
test('H17 pre-state: with no usable tool_use_id the OLD blanket pre-existing denial is KEPT — and the message names tool_use_id as the reason', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// conductor rebuild, not yet committed\n');
    const conductorBytes = readFileSync(bundle, 'utf8');

    h17(dir, 'PreToolUse', A1); // no tool_use_id on either phase
    const r = h17(dir, 'PostToolUse', A1);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `without a per-call key the surface is unverifiable again, so the blanket denial stands — ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /tool_use_id/, 'DEGRADED-LOUD: the fallback NAMES the reason it degraded');
    assert.match(r.stderr, /PRE-EXISTING change\(s\)/, 'and it is the OLD blanket pre-existing denial, not a new bespoke refusal');
    assert.match(r.stderr, /NOT attributed to it and NOT reverted/, 'with its attribution wording intact (decision f76d7c5c)');
    assert.doesNotMatch(r.stderr, /BY THIS COMMAND/, 'the agent is still not blamed for it');
    assert.equal(readFileSync(bundle, 'utf8'), conductorBytes, 'and the uncommitted work still survives the fallback');
  } finally {
    cleanup();
  }
});

// Was: "no stamp at all → the pre-existing enforcement-dirty denial fires
// exactly as before". It no longer fires for an UNCHANGED path, so this slot
// takes the case where the denial genuinely still fires with no stamp in sight:
// a pre-dirty path whose BYTES changed inside the window. This is the other half
// of the ruling and the single most important assertion in the H17 suite — the
// half that keeps the fix from being a hole. It also pins the deliberately-open
// residual: the changed path is DENIED but NOT restored, because restoring a
// pre-image would clobber a concurrent lane's legitimate write (board 0b848342
// finding 1, deferred to its own slice).
//
// EXPECTED FAILURE SHAPE: the deny is expected GREEN today (today denies on any
// pre-dirt, for the wrong reason). The load-bearing assertions are
// `assert.match(r.stderr, /h3-contract-gate/)` — the deny NAMES the changed path
// rather than issuing a blanket refusal — and the two byte assertions proving it
// was neither reset to HEAD nor rolled back to the Pre image.
//
// CATCHES SABOTAGE: equality forced to always-EQUAL (`if (true) continue`), under
// which every pre-dirty path is treated as unchanged and allowed —
// `assert.equal(r.code, 2)` fires with actual 0. Also catches a premature
// pre-image restore being smuggled into this slice.
//
// SCOPE, since decision 7021526c v2: this is the "otherwise -> DENY" arm, NOT an
// unconditional one. The precondition below asserting that no stamp was ever
// written is load-bearing for exactly that reason — a fresh stamp matching the
// changed bytes would legitimately ALLOW here (PIN-STAMP-ON-CHANGED-PREDIRT in
// h17-pre-state-snapshot.test.mjs).
test('H17 pre-state: a pre-dirty enforcement path whose BYTES changed in-window DENIES with no stamp in sight — and is NOT restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const committed = readFileSync(bundle, 'utf8');
    const preImage = '// conductor rebuild, not yet committed\n';
    writeFileSync(bundle, preImage);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'no stamp was ever written');

    const L = tu('predirty-changed');
    h17(dir, 'PreToolUse', L);
    const tampered = '// TAMPERED IN-WINDOW on top of pre-existing dirt — enforcement neutered\n';
    writeFileSync(bundle, tampered);
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a pre-dirty path CHANGED inside the window must deny — ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /h3-contract-gate/, 'the deny NAMES the changed path');
    assert.equal(readFileSync(bundle, 'utf8'), tampered, 'NOT restored — the pre-image restore is deliberately a separate, deferred slice');
    assert.notEqual(readFileSync(bundle, 'utf8'), committed, 'and specifically not reset to HEAD');
    assert.notEqual(readFileSync(bundle, 'utf8'), preImage, 'nor rolled back to the Pre image');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// H17/enforcement-stamp PIN strengthening (upgrade-polish review round,
// 2026-08-21) — additive, written against the FIX C spec above. The fixer
// lands in parallel; postures are noted per test.
// ---------------------------------------------------------------------------

// Same subject as before — a CORRUPT stamp grants no exemption — moved to the
// site where the stamp is still load-bearing: a path CLEAN at Pre and changed
// INSIDE the window, which the fresh-stamp check (decision 4d9b76e8) is
// consulted for before any restore. Asserted at the old site it would now be
// hollow, because an unchanged pre-dirty path allows whatever the stamp says.
//
// EXPECTED FAILURE SHAPE: expected GREEN today (no exemption mechanism can be
// fooled by a corrupt stamp today). The restored-bytes assertion is what keeps
// it honest: it distinguishes "no exemption, swept normally" from an error-shaped
// deny that never reaches the sweep.
//
// CATCHES SABOTAGE: any widening of the exemption to an unparseable stamp, and
// (via the restored-bytes assertion) a corrupt stamp being promoted into an
// AC9-style error deny that skips the restore.
test('H17 stamp fix: a CORRUPT stamp file (invalid JSON) gives NO exemption to a CLEAN-at-Pre in-window change — restored to HEAD and denied', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const committed = readFileSync(bundle, 'utf8'); // CLEAN at Pre
    const stampPath = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, '{ not json at all');

    const L = tu('corruptstamp');
    h17(dir, 'PreToolUse', L);
    writeFileSync(bundle, '// tampered in-window, "attested" by an unparseable stamp\n');
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a corrupt (unparseable) stamp file must not exempt an in-window change — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), committed, 'and it is swept normally: restored to HEAD, exactly as with no stamp at all');
  } finally {
    cleanup();
  }
});

// Same move as the corrupt-JSON case above, for the wrong-SHAPE case: the stamp
// is valid JSON but an object rather than an array, and the entry it carries
// even names the tampered path. It must exempt nothing at the site where an
// exemption would matter.
//
// EXPECTED FAILURE SHAPE: expected GREEN today; the restored-bytes assertion is
// the honest half, as above.
//
// CATCHES SABOTAGE: a stamp reader that accepts an object as a single entry (or
// coerces it), which would let one hand-written line attest a tamper.
test('H17 stamp fix: a NON-ARRAY stamp file (a JSON object naming the tampered path) gives NO exemption to a CLEAN-at-Pre in-window change', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    const committed = readFileSync(bundle, 'utf8'); // CLEAN at Pre
    const stampFile = join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
    mkdirSync(dirname(stampFile), { recursive: true });

    const L = tu('nonarraystamp');
    h17(dir, 'PreToolUse', L);
    const tampered = '// tampered in-window, "attested" by a non-array stamp\n';
    writeFileSync(bundle, tampered);
    // the object even carries the CORRECT hash of the tampered bytes — shape
    // alone must be enough to refuse it
    writeFileSync(stampFile, JSON.stringify({ path: 'hooks/h3-contract-gate.mjs', sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') }));

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a stamp file that is a JSON OBJECT, not an array, must not exempt anything — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), committed, 'and it is swept normally: restored to HEAD, exactly as with no stamp at all');
  } finally {
    cleanup();
  }
});

// Was: "a deleted:true stamp entry is honored iff the path is ABSENT". The
// stamp entry has stopped being what decides this — EXISTENCE is one of the
// state terms, so a path deleted before Pre and still absent at Post is
// UNCHANGED and allows with no attestation at all, while a path that comes back
// inside the window has changed and denies. Kept as two arms over the same
// fixture, exactly as the old test had them, with the deliberate difference that
// NO stamp is written: the old test needed one for its first arm to pass.
//
// EXPECTED FAILURE SHAPE (RED): arm 1 fires on `assert.equal(r.code, 0)` with
// actual 2 — today an absent tracked enforcement path is dirt like any other and
// denies. Arm 2 is expected green today.
//
// CATCHES SABOTAGE: the existence term deleted from the equality (arm 2 allows ->
// red), equality forced always-UNEQUAL (arm 1 denies -> red), and any
// implementation that treats "no bytes to read" as "nothing to compare" and
// skips the path.
test('H17 pre-state: EXISTENCE is a state term — absent at Pre and still absent ALLOWS with no stamp; recreated in-window DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    // dirty-then-deleted: the conductor deletes a tracked bundled hook (e.g. a
    // hooks rebuild dropping a stale file) — git status shows it as deleted
    // (tracked, dirty), the enforcement-dirty condition without any bytes to hash.
    rmSync(bundle, { force: true });
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'PRECONDITION: NO stamp — the old ruling needed a deleted:true entry here, the new one does not');

    const L1 = tu('gone-unchanged');
    h17(dir, 'PreToolUse', L1);
    let r = h17(dir, 'PostToolUse', L1);
    assert.equal(r.code, 0, `an absent-at-Pre path that is still absent at Post is UNCHANGED and must allow — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(bundle), false, 'and the deletion is not undone');

    // the path exists again — existence flipped inside the window, so the state
    // changed and the ordinary denial fires.
    const L2 = tu('gone-back');
    h17(dir, 'PreToolUse', L2);
    writeFileSync(bundle, '// recreated INSIDE the window\n');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');
    r = h17(dir, 'PostToolUse', L2);
    assert.equal(r.code, 2, `recreating an absent-at-Pre enforcement path inside the window must deny — ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// Was: the same scenario made to pass by a WIDENED stamp CLI. The state
// comparison covers every path the (A) sweep can flag, not only the enforcement
// surface, so a pre-dirty BRIEF-SCOPE violation that nothing touched in-window
// allows on its own — no stamp, and no dependency on the CLI's widening. The
// scope-check class needs its own pin because it reaches the violation set
// through a different predicate (scopeCheck) than the enforcement-surface class.
//
// EXPECTED FAILURE SHAPE (RED): `assert.equal(r.code, 0)` fires with actual 2 —
// today a pre-existing out-of-contract dirty tracked file denies.
//
// CATCHES SABOTAGE: equality forced to always-UNEQUAL, and any implementation
// that applies the state comparison to the enforcement-surface predicate only
// while leaving the brief-scope predicate on the old blanket denial.
test('H17 pre-state: a pre-dirty NON-hooks BRIEF-SCOPE violation that is unchanged in-window allows on its own — no stamp involved, and it is not reverted', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // pre-existing dirt: an out-of-contract TRACKED source file (mirrors AC3(a)'s
    // brief-scope violation shape — src/other.ts sits outside blast_radius,
    // incidental_scope and out_of_scope, so scopeCheck denies it as "outside the
    // brief"), already dirty BEFORE any Bash call this turn — not tampered
    // during the command.
    const other = join(dir, 'src', 'other.ts');
    const origOther = readFileSync(other, 'utf8');
    const dirtied = origOther + '\n// pre-existing dirt from a parallel lane\n';
    writeFileSync(other, dirtied);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json')), false, 'PRECONDITION: no stamp — this no longer depends on the CLI being widened');

    const L = tu('scope-unchanged');
    h17(dir, 'PreToolUse', L);
    // the agent's own command introduces no NEW tamper — the only dirt present
    // is the pre-existing src/other.ts
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `an unchanged pre-dirty brief-scope violation must let the command proceed — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(other, 'utf8'), dirtied, 'the pre-existing dirt is left untouched, not reverted');
  } finally {
    cleanup();
  }
});

test('enforcement-stamp.mjs (widened, EXPECTED RED today): stamps a dirty non-hooks TRACKED file alongside hooks/**, and expands an untracked directory into its contained files rather than one dir-shaped entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// dirty hooks bundle\n');
    const other = join(dir, 'src', 'other.ts');
    const dirtiedOther = readFileSync(other, 'utf8') + '\n// dirty tracked src file, non-hooks\n';
    writeFileSync(other, dirtiedOther);
    // an untracked directory with two files — must expand to per-file entries,
    // not a single directory-shaped entry (mirrors AC3(c)'s `?? dir/` collapse handling)
    const evilDir = join(dir, 'src', 'evildir');
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(evilDir, 'b.ts'), 'export const b = 1;\n');

    const r = runStampCli(dir);
    assert.equal(r.status, 0, `stamp CLI must succeed with hooks + non-hooks dirt: ${oneLine(r.stderr)}`);
    const stamp = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'enforcement-stamp.json'), 'utf8'));
    const byPath = Object.fromEntries(stamp.map((e) => [e.path, e]));

    assert.ok(byPath['hooks/h3-contract-gate.mjs']?.sha256, 'the hooks bundle is still stamped with its sha256 (unchanged)');
    assert.equal(byPath['hooks/h3-contract-gate.mjs'].sha256, createHash('sha256').update(readFileSync(bundle)).digest('hex'));

    assert.ok(byPath['src/other.ts']?.sha256, 'the widened CLI now also stamps a dirty non-hooks tracked file');
    assert.equal(byPath['src/other.ts'].sha256, createHash('sha256').update(readFileSync(other)).digest('hex'));

    assert.ok(byPath['src/evildir/a.ts']?.sha256, 'an untracked directory expands to its contained files, not a single dir entry');
    assert.ok(byPath['src/evildir/b.ts']?.sha256);
    assert.equal(byPath['src/evildir/a.ts'].sha256, createHash('sha256').update(readFileSync(join(evilDir, 'a.ts'))).digest('hex'));
    assert.ok(!stamp.some((e) => e.path === 'src/evildir' || e.path === 'src/evildir/'), 'no directory-shaped entry is written, only expanded per-file entries');
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
    assert.equal(r.code, 2, `restore fs-error → deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `corrupt store → deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `git nonzero → deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `run active + brief unresolvable → deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `a baseline with traversal/absolute keys must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `staged rename of an out-of-contract file must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `spaced-path change must deny — ${oneLine(r.stderr)}`);
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
    assert.equal(r.code, 2, `multiple violations must deny — ${oneLine(r.stderr)}`);
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

// ===========================================================================
// mid-run scope amendment (run r-1417) — read path through H3 and H17.
// A run.scope_amendments entry for an exact repo-relative path makes a previously
// out-of-brief path in-contract everywhere the contract is checked; out_of_scope
// and the enforcement surface still deny (ordering is load-bearing).
// ===========================================================================

// H3 [run mode]: an out-of-brief path listed in run.scope_amendments becomes in-contract
// (still needs read-evidence); an amended out_of_scope path stays denied; the enforcement
// surface stays denied for a spawned agent. (AC1 read path.)
test('H3 [run mode]: run.scope_amendments makes an out-of-brief path in-contract; out_of_scope + enforcement still deny (AC1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h3amend-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    const brief = store.create({
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
    });
    // scope_amendments seeded as run data: src/other.ts (out-of-brief) becomes in-contract;
    // src/legacy/old.ts is a STRAY amendment that must never override out_of_scope.
    store.createRun({
      id: 'r-1',
      brief_ref: brief.id,
      branch: 'sterling/run-r-1',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
      scope_amendments: [
        { path: 'src/other.ts', reason: 'adjudicated mid-run', at: NOW },
        { path: 'src/legacy/old.ts', reason: 'stray amendment', at: NOW },
      ],
    });
    mkdirSync(join(dir, 'src', 'legacy'), { recursive: true });
    writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const o = 1;');
    writeFileSync(join(dir, 'src', 'legacy', 'old.ts'), 'export const l = 1;');

    const edit = (path, agentId = 'a1') =>
      runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: path }, agent_id: agentId }), dir);

    // amended path, but no read-evidence yet: the amendment makes it in-contract, so the
    // remaining gate is READ-EVIDENCE — not "outside the brief". (Proves scope now admits it.)
    let r = edit(join(dir, 'src', 'other.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /read-evidence/, 'amended path is in-contract; the remaining gate is read-evidence, not scope');

    // amended path WITH read-evidence → allowed, without restarting the run (AC1)
    seedLedger(dir, 'r-1', 'a1', ['src/other.ts', 'src/legacy/old.ts']);
    r = edit(join(dir, 'src', 'other.ts'));
    assert.equal(r.code, 0, `amended path with read-evidence must be allowed — ${oneLine(r.stderr)}`);

    // out_of_scope still denies even when amended (ordering is load-bearing)
    r = edit(join(dir, 'src', 'legacy', 'old.ts'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /out_of_scope/, 'an amendment can never override out_of_scope');

    // enforcement surface still denies for a spawned agent, even if it were amended
    const denyEnf = runHook('h3-contract-gate.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, '.sterling', 'config.json') }, agent_id: 'a1' }), dir);
    assert.equal(denyEnf.code, 2);
    assert.match(denyEnf.stderr, /self-protection/, 'enforcement-surface denial precedes amendment scope');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// H17: an amended path is in-contract — a Bash write to it survives the sweep (AC1 "survives H17").
test('H17 (amendment): a run.scope_amendments path is in-contract — the edit survives the sweep (AC1)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject({ amendments: [{ path: 'src/other.ts', reason: 'adjudicated mid-run', at: NOW }] });
  try {
    const other = join(dir, 'src', 'other.ts'); // tracked, out-of-brief — but AMENDED
    const edited = readFileSync(other, 'utf8') + '\n// in-contract via amendment\n';
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(other, edited);
    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1);
    assert.equal(r.code, 0, `an amended path must pass the sweep — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(other, 'utf8'), edited, 'amended-path edit NOT reverted to HEAD');
  } finally {
    cleanup();
  }
});

// H17 ordering: an amended path that ALSO matches out_of_scope is still swept + restored.
test('H17 (amendment ordering): an amended path that ALSO matches out_of_scope stays swept + restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject({ amendments: [{ path: 'src/legacy/old.ts', reason: 'stray amendment', at: NOW }] });
  try {
    const legacy = join(dir, 'src', 'legacy', 'old.ts'); // out_of_scope AND amended
    const orig = readFileSync(legacy, 'utf8');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(legacy, orig + '\n// tamper on an out_of_scope path\n');
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `out_of_scope beats the amendment — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(legacy, 'utf8'), orig, 'out_of_scope amended path still restored to HEAD');
  } finally {
    cleanup();
  }
});
