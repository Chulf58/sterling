import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, statSync } from 'node:fs';
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
test("H19 delivery-drain: pruneUnhashed targets ONLY the conductor ledger — an AGENT/run ledger's hashless entry survives untouched", () => {
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    const conductorLedger = join(dir, '.sterling', 'transient', 'conductor-reads.json');
    mkdirSync(dirname(conductorLedger), { recursive: true });
    writeFileSync(
      conductorLedger,
      JSON.stringify([
        { agent_id: 'conductor', path: 'src/legacy-read.ts', at: NOW },
        { agent_id: 'conductor', path: 'src/feature.ts', at: NOW, sha256: 'deadbeef' },
      ])
    );
    // an AGENT/run ledger with its OWN hashless entry, seeded via the same
    // helper h13-reads-ledger's tests use for the run-scoped path.
    const agentLedger = seedLedger(dir, 'r-1', 'a1', ['src/agent-legacy-read.ts']);
    const agentBefore = readFileSync(agentLedger, 'utf8');

    const r = runHook('h19-delivery-drain.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r.code, 0, oneLine(r.stderr));

    const conductorAfter = JSON.parse(readFileSync(conductorLedger, 'utf8'));
    assert.ok(!conductorAfter.some((e) => e.path === 'src/legacy-read.ts'), 'the hashless CONDUCTOR entry is pruned');
    assert.ok(conductorAfter.some((e) => e.path === 'src/feature.ts'), 'the hashed CONDUCTOR entry survives');

    assert.equal(
      readFileSync(agentLedger, 'utf8'),
      agentBefore,
      "the AGENT/run ledger is byte-identical — untouched by the conductor-scoped prune"
    );
    const agentAfter = JSON.parse(readFileSync(agentLedger, 'utf8'));
    assert.ok(
      agentAfter.some((e) => e.path === 'src/agent-legacy-read.ts'),
      "the agent ledger's own hashless entry survives — this hook never targets it"
    );
  } finally {
    cleanup();
  }
});
// Sabotage: resolving the prune path from the hook input's own agent/run
// identity (an "undefined,undefined" targeting bug — e.g. falling through to
// whatever ledgerPath(run_id, agent_id) happens to produce instead of a
// FIXED conductor-only path), or globbing every ledger under
// .sterling/runs/**/reads/*.json, flips the agent-ledger-survives assertions
// above red.

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
  const liveProbe = join(root, 'hooks', 'h15-store-guard.mjs');
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
    const bundled = join(outDir, 'h15-store-guard.mjs');
    assert.ok(existsSync(bundled));
    assert.ok(!readFileSync(bundled, 'utf8').includes("from '@sterling/"), 'no workspace imports at runtime');
    const r = spawnSync(process.execPath, [bundled], {
      input: JSON.stringify(hookInput(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, '.sterling', 'sterling.db') }, cwd: dir })),
      encoding: 'utf8',
      cwd: dir,
      timeout: 30_000,
    });
    assert.equal(r.status, 2, oneLine(r.stderr));
    assert.match(r.stderr ?? '', /store database/);

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
      'h7-file-touch.mjs': 'PostToolUse',
      'h10-direct-capture.mjs': 'Stop',
      'h19-delivery-drain.mjs': 'UserPromptSubmit',
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
