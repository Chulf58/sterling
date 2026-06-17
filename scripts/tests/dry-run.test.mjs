import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
let SterlingTools;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SterlingTools } = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'index.js')).href));
});

function sh(script, args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 180_000,
    // isolate the machine-global project registry to the test dir (init registers there)
    env: { ...process.env, STERLING_REGISTRY_DB: join(cwd, 'registry.db'), ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function envelope(type) {
  return {
    id: randomUUID(), type, created_at: NOW(), updated_at: NOW(), author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: ['node'],
  };
}

test('§16.2 step 11 — end-to-end dry run: init → conductor-direct capture → one-phase pipeline → confirmations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dry-'));
  let store;
  try {
    // ---- a fresh git project ----
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'dry@sterling.local']);
    git(dir, ['config', 'user.name', 'Dry Run']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ "name": "dry-target", "private": true, "type": "module" }\n');
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export const app = () => 0;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);

    // ---- INIT (the §12 manifest) ----
    const noBackup = sh('init.mjs', ['--target', dir, '--project-name', 'dry', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs'], dir);
    assert.equal(noBackup.code, 2, 'refuses without backup path or explicit opt-out (§2.3)');
    const init = sh(
      'init.mjs',
      ['--target', dir, '--project-name', 'dry-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs,**/*.js', '--backup-path', 'backups'],
      dir
    );
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /RESTART REQUIRED/);
    assert.match(init.stdout, /no mutation capability/, 'init warns once per absent optional capability');
    for (const artifact of ['.sterling/sterling.db', '.sterling/config.json', 'docs/briefs', 'CLAUDE.md', 'sterling.bat', '.claude/agents/coder.md']) {
      assert.ok(existsSync(join(dir, artifact)), `init created ${artifact}`);
    }
    // consuming project: no per-project .mcp.json — the plugin declares the sterling server
    assert.ok(!existsSync(join(dir, '.mcp.json')), 'no per-project .mcp.json (the plugin declares sterling via the plugin dir)');
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /dry-target/);
    assert.match(claudeMd, /Stack tags.*: node/);
    assert.ok(!claudeMd.includes('{{'), 'no unsubstituted template tokens');
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    for (const line of ['.sterling/', 'sterling.bat', '.claude/agents/', 'backups/']) {
      assert.ok(gitignore.includes(line), `gitignore has ${line} (in-repo backup path per §12)`);
    }
    // re-run is an ensure pass (§12), not a refusal: everything matches, contradicting flags reported
    const rerun = sh('init.mjs', ['--target', dir, '--project-name', 'dry', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'], dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+matches\b/m);
    assert.match(rerun.stdout, /note: --toolchain, --project-name differ\(s\) from the recorded config — NOT applied/);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'sterling init']);

    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const tools = new SterlingTools({ store });

    // ---- tiny conductor-direct task: edit a file; H7 registers; capture fires; H10 releases ----
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export const app = () => 1; // tuned\n');
    const h7 = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h7-file-touch.mjs')], {
      input: JSON.stringify({ session_id: 's', transcript_path: 't', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'app.mjs') } }),
      encoding: 'utf8', cwd: dir, timeout: 30_000,
    });
    assert.equal(h7.status, 0, h7.stderr);
    tools.knowledgeCreate('decision', { title: 'app returns 1', statement: 'tuned baseline', alternatives_rejected: [], rationale: 'dry-run capture' });
    const h10 = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs')], {
      input: JSON.stringify({ session_id: 's', transcript_path: 't', cwd: dir, hook_event_name: 'Stop' }),
      encoding: 'utf8', cwd: dir, timeout: 30_000,
    });
    assert.equal(h10.status, 0, 'capture fired → the direct envelope releases the session');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'direct task']);

    // ---- pipeline: brief → GATE (start-run) → phase → completeness → capture → dispose → merge ----
    const todo = tools.boardAdd({ text: 'ship the sum command', source: 'user' }).record;
    const { record: brief } = tools.knowledgeCreate('brief', {
      slug: 'sum', title: 'Sum', problem: 'no sum', feature: 'sum(a,b)',
      user_stated: { criteria: ['user said: integers'], constraints: [] },
      conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'sum(2,3) is 5 via the entry point', verifiable_at: 'final' }],
      technical_design: { approach: 'module + wire', interfaces: [{ name: 'sum', contract: 'sum(a,b) -> number' }], shared_structures: [] },
      risk_flags: [],
      blast_radius: {
        files: [
          { path: 'src/sum.mjs', owning_articles: [] },
          { path: 'src/app.mjs', owning_articles: [] },
          { path: 'tests/sum.test.mjs', owning_articles: [] },
        ],
        reconcile_list: [],
      },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'sum', subtasks: ['build sum'], ac_ids: ['AC1'], files: ['src/sum.mjs', 'src/app.mjs'], interfaces: ['sum'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });

    // grill-plan flags on the gate-ready brief: only the absent risk flags need one look
    const flags = sh('grill-plan-flags.mjs', ['--brief', brief.id, '--target', dir], dir);
    assert.deepEqual(JSON.parse(flags.stdout).flags.map((f) => f.kind), ['no_risk_flags']);

    // GATE APPROVAL → the owned surface (visibility gate uses a post-install session timestamp)
    const blockedStart = sh('start-run.mjs', ['--brief', brief.id, '--session-started', '2020-01-01T00:00:00.000Z', '--target', dir], dir);
    assert.equal(blockedStart.code, 2);
    assert.match(blockedStart.stderr, /restart_required/, 'the §12 restart gate blocks the first run for a stale session');
    const started = sh('start-run.mjs', ['--brief', brief.id, '--session-started', NOW(), '--run-id', 'r-dry', '--target', dir], dir);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'sterling/run-r-dry', 'gate approval put the tree ON the run branch');

    // prep [S]
    assert.equal(sh('prep.mjs', ['--run', 'r-dry', '--phase', 'p1', '--target', dir], dir).code, 0);

    // test-writer stand-in → red (baseline frozen) → consume its intra-phase complete
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'sum.mjs'), 'export const sum = () => 0;\n');
    writeFileSync(join(dir, 'tests', 'sum.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from '../src/sum.mjs';\ntest('AC1', () => assert.equal(sum(2, 3), 5));\n");
    tools.handoffWrite({ run_id: 'r-dry', handoff: { phase_id: 'p1', agent_role: 'test-writer', what_changed: [{ path: 'tests/sum.test.mjs', change_role: 'AC1 oracle' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/sum.test.mjs'], exit_signal: 'complete', unresolved: [] } });
    const red = sh('test-check.mjs', ['--expect', 'red', '--scope', 'tests/sum.test.mjs', '--run', 'r-dry', '--phase', 'p1', '--target', dir], dir);
    assert.equal(red.code, 0, red.stdout + red.stderr);
    tools.agentExit({ run_id: 'r-dry', phase_id: 'p1', agent_role: 'test-writer', signal: 'complete', payload: { handoff_ref: 'p1/test-writer' } });
    assert.equal(sh('consume-exit.mjs', ['--run', 'r-dry', '--step', 'tests-written', '--target', dir], dir).code, 0, 'intra-phase complete consumed (§5.2)');

    // coder stand-in → green → boundary complete → run_signal
    writeFileSync(join(dir, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    writeFileSync(join(dir, 'src', 'app.mjs'), "import { sum } from './sum.mjs';\nexport const app = () => sum(2, 3);\n");
    tools.handoffWrite({ run_id: 'r-dry', handoff: { phase_id: 'p1', agent_role: 'coder', what_changed: [{ path: 'src/sum.mjs', change_role: 'implemented' }, { path: 'src/app.mjs', change_role: 'wired' }], wired: ['sum'], deferred: [], decisions_made: ['kept sum binary'], tests_produced: [], subtask_evidence: [{ subtask: 'build sum', files: ['src/sum.mjs', 'src/app.mjs'], tests: ['tests/sum.test.mjs'] }], exit_signal: 'complete', unresolved: [] } });
    assert.equal(sh('test-check.mjs', ['--expect', 'green', '--scope', 'tests/sum.test.mjs', '--run', 'r-dry', '--target', dir], dir).code, 0);
    tools.knowledgeCreate('decision', { title: 'sum stays binary', statement: 'no variadic sum', alternatives_rejected: [{ option: 'variadic', reason: 'no AC needs it' }], rationale: 'smallest change' });
    spawnSync('git', ['add', '-A'], { cwd: dir, timeout: 30_000 });
    spawnSync('git', ['commit', '-m', 'phase p1', '--no-verify'], { cwd: dir, timeout: 30_000 });
    tools.agentExit({ run_id: 'r-dry', phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const boundary = tools.runSignal({ run_id: 'r-dry' });
    assert.equal(boundary.action.action, 'complete_run');

    // final completeness [S]: citations verified, suite green, whole-run diff in contract, H12 wired
    const comp = sh('completeness-check.mjs', ['--run', 'r-dry', '--phase', 'p1', '--final', '--target', dir], dir);
    assert.equal(comp.code, 0, comp.stderr);
    const compOut = JSON.parse(comp.stdout);
    assert.deepEqual(compOut.wiring.violations, []);
    assert.ok(!compOut.check_skipped.some((s) => s.check === 'whole-run-diff'), 'whole-run diff RAN against the real base branch');

    // capture: article (AC-traced, fulfills the todo) + board removal by the fulfilling write
    const { record: article } = tools.knowledgeCreate('feature_article', {
      slug: 'sum', title: 'Sum', what_it_does: 'adds two numbers', intended_behavior: 'app() returns sum(2,3)=5',
      files: [{ path: 'src/sum.mjs', role: 'impl' }, { path: 'src/app.mjs', role: 'wiring' }],
      current_ac: [{ ac_id: 'AC1', text: 'sum via entry point', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
      history: [{ date: NOW(), event: 'originating brief', target_id: brief.id }],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests/sum.test.mjs'] }],
      links: [{ rel: 'fulfills', target_id: todo.id }],
    });
    tools.boardRemove(todo.id);

    // dispose-run: verify → snapshot → rows → dir → awaiting_merge_gate
    const dispose = sh('dispose-run.mjs', ['--run', 'r-dry', '--target', dir], dir);
    assert.equal(dispose.code, 0, dispose.stdout + dispose.stderr);
    const disposed = JSON.parse(dispose.stdout);
    assert.ok(existsSync(disposed.snapshot), 'store snapshot written to the (gitignored) backup path');

    // merge gate: human decision → REAL merge, branch deleted
    const merged = sh('merge-gate.mjs', ['--run', 'r-dry', '--decision', 'merge', '--target', dir], dir);
    assert.equal(merged.code, 0, merged.stderr);

    // ---- §16.2 step 11 confirmations ----
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'CONFIRMED: board removal');
    const articles = store.query({ types: ['feature_article'], cap: 10 });
    assert.equal(articles.length, 1, 'CONFIRMED: article write');
    assert.equal(articles[0].id, article.id);
    assert.equal(existsSync(join(dir, '.sterling', 'runs', 'r-dry')), false, 'CONFIRMED: run-dir disposal');
    assert.equal(store.readHandoffs('r-dry').length, 0, 'CONFIRMED: run-scoped rows disposed');
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'CONFIRMED: back on main');
    assert.equal(git(dir, ['branch', '--list', 'sterling/*']), '', 'CONFIRMED: run branch deleted');
    assert.match(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8'), /a \+ b/, 'CONFIRMED: merged work on main');
    assert.equal(store.getRun('r-dry').machine_state, 'merged');
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('init: backup opt-out is recorded and disposal skips the snapshot LOUDLY (§2.3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-optout-'));
  let store;
  try {
    git(dir, ['init', '-b', 'main']);
    const init = sh('init.mjs', ['--target', dir, '--project-name', 'x', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-opt-out'], dir);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /OPTED OUT/);
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(config.backup_opt_out, true, 'opt-out is RECORDED, not implicit');
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
