// REGRESSION (board residuals-from-the-h10-h22-owner-fix, residual 1): a
// register `files` entry that names a FILE must never own paths beneath it.
// The scenario from Sol's re-check: one lane's territory names the file
// `src/a`; the file is deleted, and another lane creates `src/a/b`. The shared
// matcher (pathOwnedBy in scripts/hooks/lib/dispatch-residue.mjs) treated
// every entry as a possible directory, so `src/a` owned `src/a/b`: H10
// deferred that path to the wrong live owner and the residue probe reported it
// as the first lane's uncommitted edit.
//
// A stat when H10 checks cannot tell the kind: once `src/a/b` exists, `src/a`
// is a directory on disk (FE-1 asserts this). So H22 records the kind at
// SubagentStart: entries that are regular files on disk at that moment go into
// `file_entries`, and only those lose the prefix match. Missing entries and
// directories keep it (decision h22-dispatch-files-from-review-territory-and-
// resume-inherits-prior-round, 2026-09-29 amendment: a slash-less entry is a
// directory). Registers written before `file_entries` existed keep today's
// prefix match for every entry.
//
// Harness duplicated from h22-review-territory-and-resume-ownership.test.mjs
// rather than imported (importing would double-run its registered tests).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const RESIDUE_LIB = join(HOOKS, 'lib', 'dispatch-residue.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-file-entry-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const h22 = (input, dir) => runHook('h22-dispatch-register.mjs', input, dir);
const out = (r) => `${r.stdout}\n${r.stderr}`;

const task = (dir, event, { tool_use_id, subagent_type, prompt, agentId }) => ({
  hook_event_name: event,
  tool_name: 'Task',
  tool_use_id,
  tool_input: { subagent_type, prompt, description: 'a lane' },
  ...(event === 'PostToolUse'
    ? { tool_response: { isAsync: true, status: 'async_launched', agentId, description: 'a lane', resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true } }
    : {}),
  session_id: 's1',
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});
const lifecycle = (dir, event, agent_id, agent_type = 'implementor') => ({
  hook_event_name: event,
  session_id: 's1',
  transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
  cwd: dir,
  prompt_id: 'pr-1',
  agent_id,
  agent_type,
  ...(event === 'SubagentStop' ? { last_assistant_message: 'done' } : {}),
});

function dispatch(dir, { tool_use_id, agent_id, prompt, subagent_type = 'implementor' }) {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const r = h22(task(dir, event, { tool_use_id, subagent_type, prompt, agentId: agent_id }), dir);
    assert.equal(r.code, 0, `${event}: ${r.stderr}`);
  }
  const s = h22(lifecycle(dir, 'SubagentStart', agent_id, subagent_type), dir);
  assert.equal(s.code, 0, `SubagentStart: ${s.stderr}`);
  return s;
}

const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');
const readRegister = (dir) => JSON.parse(readFileSync(registerPath(dir), 'utf8'));
const roundsFor = (dir, agentId) => readRegister(dir).filter((e) => e.agent_id === agentId);

function write(dir, rel, body = '# file\n') {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function touch(dir, paths) {
  const at = new Date().toISOString();
  for (const p of paths) write(dir, p, '# touched\n');
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

const stop = (dir) =>
  runHook('h10-direct-capture.mjs', { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }, dir);

function deferralLine(r, dir) {
  const notices = join(dir, '.sterling', 'transient', 'notices');
  const noticeTexts = existsSync(notices) ? readdirSync(notices).map((n) => JSON.parse(readFileSync(join(notices, n), 'utf8')).text) : [];
  const text = [out(r), ...noticeTexts].join('\n');
  const line = text.split(/\\n|\n/).find((l) => /deferred: \d+ file\(s\) owned by live dispatch/.test(l));
  assert.ok(line, `H10 disclosed a deferral: ${text}`);
  return line;
}

const LANE_A_BRIEF = 'Lane A.\nREVIEW-TERRITORY: ["src/a", "src/dir", "src/planned"]';

// Lane A declares the existing FILE src/a, the existing DIRECTORY src/dir and
// the missing slash-less entry src/planned.
function seedLaneA(dir) {
  write(dir, 'src/a', '// a file\n');
  write(dir, 'src/dir/seed.gd');
  dispatch(dir, { tool_use_id: 'toolu_laneA', agent_id: 'lane-a', prompt: LANE_A_BRIEF });
}

// Lane A's file src/a is deleted and another lane creates src/a/b.
function replaceFileWithChild(dir) {
  rmSync(join(dir, 'src', 'a'));
  touch(dir, ['src/a/b', 'src/dir/x.gd', 'src/planned/y.gd']);
}

test('FE-1: SubagentStart records ONLY the entries that are regular files on disk in file_entries', () => {
  const { dir, cleanup } = makeProject();
  try {
    seedLaneA(dir);
    const [entry] = roundsFor(dir, 'lane-a');
    assert.deepEqual(entry.files, ['src/a', 'src/dir', 'src/planned'], 'files is unchanged: the declared territory');
    assert.deepEqual(entry.file_entries, ['src/a'], 'the directory and the missing entry are not file entries');
  } finally {
    cleanup();
  }
});

test('FE-2: H10 does not defer a child created under a file entry, and a directory or missing slash-less entry still owns its children', () => {
  const { dir, cleanup } = makeProject();
  try {
    seedLaneA(dir);
    replaceFileWithChild(dir);
    // At check time src/a is a directory, so only the Start-time record can tell.
    assert.equal(statSync(join(dir, 'src', 'a')).isDirectory(), true);
    const line = deferralLine(stop(dir), dir);
    assert.match(line, /deferred: 2 file\(s\) owned by live dispatch\(es\) \[lane-a\]/, line);
    assert.match(line, /src\/dir\/x\.gd/, `a declared directory owns a new child: ${line}`);
    assert.match(line, /src\/planned\/y\.gd/, `a slash-less entry missing at Start keeps directory behaviour (2026-09-29): ${line}`);
    assert.doesNotMatch(line, /src\/a\/b/, `a file entry owns nothing beneath it: ${line}`);
  } finally {
    cleanup();
  }
});

test('FE-3: a LEGACY register row without file_entries keeps the prefix match for every entry', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(
      registerPath(dir),
      JSON.stringify([
        { agent_id: 'lane-old', agent_type: 'implementor', session_id: 's1', files: ['src/a'], files_source: 'review-territory', attribution: 'block', at: new Date().toISOString() },
      ])
    );
    touch(dir, ['src/a/b']);
    const line = deferralLine(stop(dir), dir);
    assert.match(line, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-old\]: src\/a\/b/, line);
  } finally {
    cleanup();
  }
});

test('FE-4: a RESUMED round inherits file_entries together with files', () => {
  const { dir, cleanup } = makeProject();
  try {
    seedLaneA(dir);
    assert.equal(h22(lifecycle(dir, 'SubagentStop', 'lane-a'), dir).code, 0);
    // The file is gone by the resume; the kind recorded at the first Start stands.
    rmSync(join(dir, 'src', 'a'));
    const s = h22(lifecycle(dir, 'SubagentStart', 'lane-a'), dir);
    assert.equal(s.code, 0, s.stderr);
    const resumed = roundsFor(dir, 'lane-a').find((e) => !e.ended);
    assert.equal(resumed.files_source, 'resume-inherited', 'sanity: classified as a resume');
    assert.deepEqual(resumed.files, ['src/a', 'src/dir', 'src/planned']);
    assert.deepEqual(resumed.file_entries, ['src/a']);
  } finally {
    cleanup();
  }
});

test('FE-5: pathOwnedBy prefix-matches only when the entry is not a file entry; the two-argument call is unchanged', async () => {
  const { pathOwnedBy } = await import(pathToFileURL(RESIDUE_LIB).href);
  assert.equal(pathOwnedBy('src/a', 'src/a/b', true), false, 'a file entry owns nothing beneath it');
  assert.equal(pathOwnedBy('src/a', 'src/a', true), true, 'a file entry owns itself');
  assert.equal(pathOwnedBy('src/a', 'src/a/b', false), true);
  assert.equal(pathOwnedBy('src/a', 'src/a/b'), true, 'without kind information an entry keeps the prefix match');
});

function gitRun(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

// A git project whose committed file src/a was deleted, with src/a/b created
// in its place by another lane.
function makeGitProjectFileReplacedByChild() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-file-entry-git-'));
  gitRun(dir, ['init', '-q']);
  gitRun(dir, ['config', 'user.email', 'file-entry@sterling.test']);
  gitRun(dir, ['config', 'user.name', 'File Entry Test']);
  gitRun(dir, ['config', 'commit.gpgsign', 'false']);
  write(dir, '.gitignore', '.sterling/\n');
  write(dir, 'src/a', '// committed file\n');
  gitRun(dir, ['add', '-A']);
  gitRun(dir, ['commit', '-q', '-m', 'seed']);
  rmSync(join(dir, 'src', 'a'));
  write(dir, 'src/a/b', '// lane 2\n');
  return dir;
}

test('FE-6: the residue probe does not report a child created under a file entry as that lane\'s edit', { skip: GIT_SKIP }, async () => {
  const { probeDirtyPaths } = await import(pathToFileURL(RESIDUE_LIB).href);
  const dir = makeGitProjectFileReplacedByChild();
  try {
    const asFile = probeDirtyPaths(dir, ['src/a'], ['src/a']);
    assert.equal(asFile.verified, true);
    assert.deepEqual(asFile.dirty, ['src/a'], 'the deleted file is the lane\'s residue; src/a/b is not');

    const legacy = probeDirtyPaths(dir, ['src/a']);
    assert.deepEqual([...legacy.dirty].sort(), ['src/a', 'src/a/b'], 'without file entries the probe keeps the prefix match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FE-7: H1 SessionStart residue for an orphaned round does not report another lane\'s child path under a file entry', { skip: GIT_SKIP }, () => {
  const dir = makeGitProjectFileReplacedByChild();
  try {
    write(dir, '.sterling/config.json', JSON.stringify({ ...CONFIG, dispatch_register: { stale_minutes: 5 } }));
    write(dir, '.sterling/transient/dispatch-register.json', JSON.stringify([
      {
        agent_id: 'orphan-file', agent_type: 'implementor', session_id: 's1',
        files: ['src/a'], file_entries: ['src/a'], files_source: 'review-territory', attribution: 'block',
        at: new Date(Date.now() - 90 * 60_000).toISOString(),
      },
    ]));
    const r = runHook('h1-session-start.mjs', { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' }, dir);
    assert.equal(r.code, 0, r.stderr);
    const text = out(r);
    const line = text.split(/\\n|\n/).find((l) => /dispatch implementor:orphan-file stopped holding uncommitted edits/.test(l));
    assert.ok(line, `H1 reports the orphan's deleted file as residue: ${text}`);
    assert.match(line, /edits to src\/a[;[ ]/, `the deleted file src/a is named: ${line}`);
    assert.doesNotMatch(line, /src\/a\/b/, `another lane's src/a/b is not this round's residue: ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
