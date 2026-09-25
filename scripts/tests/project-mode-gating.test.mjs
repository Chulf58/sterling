// Project mode gating (decision project-mode-hobby-work-toggle-decides-flow,
// slice S1): OpenCode agents and the handoff projection are WORK-ONLY. Every
// surface reads the TARGET project's own .sterling/config.json `mode`:
//   - a missing key means hobby; an invalid value is refused, never guessed;
//   - hobby prints a loud skip line and writes nothing;
//   - work→hobby deletes nothing (the skip line says so);
//   - hobby→work is provisioned by sync-agents, init, and an already-current
//     /sterling:update (HEAD unchanged) for a work project whose files are missing.
// init's own arms live in init-ensure.test.mjs (they need its harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProjectMode, ProjectModeError } from '../lib/handoff-projection.mjs';
import { runUpdate, UPDATE_MARKER_RELATIVE_PATH } from '../lib/update.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);

const PORTABLE = ['implementor', 'researcher', 'scout'];
const HANDOFF_FILES = ['architecture.md', 'rulings.md'];

function project(mode, { store = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-gate-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, mode);
  if (store) new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}
function writeConfig(dir, mode) {
  const cfg = { project_name: 'fixture', ...(mode === undefined ? {} : { mode }) };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
const opencodeFiles = (dir) => (existsSync(join(dir, '.opencode', 'agents')) ? readdirSync(join(dir, '.opencode', 'agents')).sort() : []);
const handoffFiles = (dir) => HANDOFF_FILES.filter((f) => existsSync(join(dir, f)));
const snapshot = (dir) => Object.fromEntries([
  ...opencodeFiles(dir).map((f) => `.opencode/agents/${f}`),
  ...handoffFiles(dir),
].map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const syncAgents = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir });
const handoff = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'handoff-projection.mjs'), dir], { encoding: 'utf8', cwd: dir });

// ---------------------------------------------------------------- readProjectMode

test('readProjectMode: missing config or missing key → hobby; hobby/work as declared', () => {
  const none = mkdtempSync(join(tmpdir(), 'sterling-mode-none-'));
  const dirs = [none, project(undefined, { store: false }), project('hobby', { store: false }), project('work', { store: false })];
  try {
    assert.deepEqual(dirs.map((d) => readProjectMode(d)), ['hobby', 'hobby', 'hobby', 'work']);
  } finally {
    dirs.forEach(cleanup);
  }
});

test('readProjectMode: an invalid value or unparseable config is refused loudly, naming the value', () => {
  const bad = project('Work', { store: false });
  const broken = project('work', { store: false });
  writeFileSync(join(broken, '.sterling', 'config.json'), '{ not json');
  try {
    assert.throws(() => readProjectMode(bad), (e) => e instanceof ProjectModeError && /"Work"/.test(e.message) && /'hobby' or 'work'/.test(e.message));
    assert.throws(() => readProjectMode(broken), (e) => e instanceof ProjectModeError && /not valid JSON/.test(e.message));
    // the refusals parseConfig no longer makes (it preserves the raw value)
    for (const raw of ['', 'hobbyist', 1, true, null, ['work'], { mode: 'work' }]) {
      writeFileSync(join(bad, '.sterling', 'config.json'), JSON.stringify({ mode: raw }));
      assert.throws(() => readProjectMode(bad), (e) => e instanceof ProjectModeError && e.message.includes(JSON.stringify(raw)), `mode ${JSON.stringify(raw)} refused`);
    }
  } finally {
    cleanup(bad);
    cleanup(broken);
  }
});

// ---------------------------------------------------------------- handoff-projection CLI

test('handoff CLI: a hobby target is a STANDING refusal (exit 2) — nothing written', () => {
  for (const mode of ['hobby', undefined]) {
    const dir = project(mode);
    try {
      const r = handoff(dir);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /^handoff projection: REFUSED — project mode is hobby \(OpenCode and handoff files are work-only/m);
      assert.deepEqual(handoffFiles(dir), []);
      assert.ok(!existsSync(join(dir, 'docs')));
    } finally {
      cleanup(dir);
    }
  }
});

test('handoff CLI: an invalid mode is an ACTIONABLE refusal (exit 3) naming the value — nothing written', () => {
  const dir = project('hobbyist');
  try {
    const r = handoff(dir);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^handoff projection: REFUSED — .*"hobbyist"/m);
    assert.deepEqual(handoffFiles(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('handoff CLI: a work target is projected', () => {
  const dir = project('work');
  try {
    const r = handoff(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^handoff projection: written/m);
    assert.deepEqual(handoffFiles(dir), HANDOFF_FILES);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- sync-agents

test('sync-agents: a hobby target gets no OpenCode agents and a loud skip line; Claude agents still sync', () => {
  const dir = project('hobby');
  try {
    const r = syncAgents(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^portable agents \(\.opencode\/agents\/\) SKIPPED — project mode is hobby \(OpenCode and handoff files are work-only/m);
    assert.doesNotMatch(r.stdout, /\.opencode\/agents\/\w+\.md/);
    assert.deepEqual(opencodeFiles(dir), []);
    assert.match(r.stdout, /^installed: implementor$/m, 'the Claude Code agents are not mode-gated');
  } finally {
    cleanup(dir);
  }
});

test('sync-agents: a work target gets the portable OpenCode agents', () => {
  const dir = project('work');
  try {
    const r = syncAgents(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const name of PORTABLE) assert.match(r.stdout, new RegExp(`^installed: \\.opencode/agents/${name}\\.md$`, 'm'));
    assert.deepEqual(opencodeFiles(dir), PORTABLE.map((n) => `${n}.md`));
  } finally {
    cleanup(dir);
  }
});

test('sync-agents: an invalid mode refuses the whole sync (exit 2), naming the value — never a raw schema throw', () => {
  const dir = project('both');
  try {
    const r = syncAgents(dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^refused_project_mode: .*"both".*nothing synced/m);
    assert.deepEqual(opencodeFiles(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('sync-agents: work→hobby deletes nothing and says the files are no longer maintained; hobby→work provisions', () => {
  const dir = project('hobby');
  try {
    assert.equal(syncAgents(dir).status, 0);
    assert.deepEqual(opencodeFiles(dir), [], 'hobby: nothing yet');
    writeConfig(dir, 'work');
    const toWork = syncAgents(dir);
    assert.equal(toWork.status, 0, toWork.stdout + toWork.stderr);
    assert.deepEqual(opencodeFiles(dir), PORTABLE.map((n) => `${n}.md`), 'hobby→work: provisioned on the next sync');
    const before = snapshot(dir);
    writeConfig(dir, 'hobby');
    const toHobby = syncAgents(dir);
    assert.equal(toHobby.status, 0, toHobby.stdout + toHobby.stderr);
    assert.match(toHobby.stdout, /SKIPPED — project mode is hobby .*existing files are no longer maintained.*nothing is deleted/);
    assert.deepEqual(snapshot(dir), before, 'work→hobby: every file byte-identical');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- /sterling:update fan-out

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

// git and npm are faked; sync-agents and handoff-projection RUN for real (from
// this clone) against the temp targets, so "files written" is observed on disk.
function updateExec({ behind }) {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged || !behind ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged || !behind ? '0\t0' : `${behind}\t0`);
      if (a === 'status --porcelain') return ok('');
      if (a.startsWith('merge --ff-only')) { merged = true; return ok('Fast-forward'); }
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    const script = args[0]?.split(/[\\/]/).pop();
    if (script === 'sync-agents.mjs' || script === 'handoff-projection.mjs') {
      const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args.slice(1)], { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (script === 'stamp-contract.mjs') return ok('0 refusal(s).\n');
    return ok('done');
  };
  return { exec, calls };
}

async function update({ behind, projects, cwd }) {
  const { exec, calls } = updateExec({ behind });
  const lines = [];
  const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: projects.map((p) => ({ name: p.split(/[\\/]/).pop(), repo_path: p })), opts: {} });
  return { report, log: lines.join('\n'), handoffCalls: calls.filter((c) => c.includes('handoff-projection.mjs')), syncCalls: calls.filter((c) => c.includes('sync-agents.mjs')) };
}
const scratch = () => mkdtempSync(join(tmpdir(), 'sterling-mode-update-cwd-'));
const seedMarker = (cwd, sha) => {
  mkdirSync(join(cwd, '.sterling'), { recursive: true });
  writeFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), JSON.stringify({ sha, completed_at: new Date().toISOString(), handoff_retry: [] }));
};

test('update fan-out: a hobby project gets a loud skip line and no files; a work project gets both file sets', async () => {
  const cwd = scratch();
  const hobby = project('hobby');
  const work = project('work');
  try {
    const { report, log, handoffCalls } = await update({ behind: 2, projects: [hobby, work], cwd });
    assert.equal(report.exit, 0, log);
    assert.deepEqual(handoffCalls.map((c) => c.split(' ').pop()), [work], 'the projection runs only for the work project');
    assert.match(log, /skipped — project mode is hobby \(OpenCode and handoff files are work-only/);
    assert.deepEqual(opencodeFiles(hobby), []);
    assert.deepEqual(handoffFiles(hobby), []);
    assert.deepEqual(opencodeFiles(work), PORTABLE.map((n) => `${n}.md`));
    assert.deepEqual(handoffFiles(work), HANDOFF_FILES);
    assert.deepEqual(report.projects.map((p) => p.handoff), ['skipped', 0]);
  } finally {
    [cwd, hobby, work].forEach(cleanup);
  }
});

test('update fan-out: an invalid mode is refused loudly and joins the retry set', async () => {
  const cwd = scratch();
  const bad = project('WORK');
  try {
    const { report, log, handoffCalls } = await update({ behind: 2, projects: [bad], cwd });
    assert.equal(handoffCalls.length, 0);
    assert.match(log, /✗ .*"WORK"/);
    assert.equal(report.exit, 2);
    assert.deepEqual(report.handoff_retry, [bad]);
  } finally {
    [cwd, bad].forEach(cleanup);
  }
});

test('update, HEAD unchanged: hobby→work is provisioned; a provisioned work project and a hobby project are left alone', async () => {
  const cwd = scratch();
  const switched = project('hobby');
  const hobby = project('hobby');
  try {
    // a full update while the project is still hobby: nothing written
    await update({ behind: 2, projects: [switched, hobby], cwd });
    assert.deepEqual(opencodeFiles(switched), []);
    assert.deepEqual(handoffFiles(switched), []);
    // the user flips it to work in the TUI; the clone is already current
    writeConfig(switched, 'work');
    seedMarker(cwd, HEAD_B);
    const first = await update({ behind: 0, projects: [switched, hobby], cwd });
    assert.equal(first.report.exit, 0, first.log);
    assert.deepEqual(opencodeFiles(switched), PORTABLE.map((n) => `${n}.md`), 'OpenCode agents provisioned with HEAD unchanged');
    assert.deepEqual(handoffFiles(switched), HANDOFF_FILES, 'handoff projection provisioned with HEAD unchanged');
    assert.deepEqual(first.handoffCalls.map((c) => c.split(' ').pop()), [switched]);
    assert.deepEqual(opencodeFiles(hobby), [], 'the hobby project is untouched');
    assert.match(first.log, /provisioning .*work-mode/i);
    // a second already-current run has nothing to provision
    const second = await update({ behind: 0, projects: [switched, hobby], cwd });
    assert.equal(second.handoffCalls.length + second.syncCalls.length, 0, second.log);
    assert.match(second.log, /Already current/);
  } finally {
    [cwd, switched, hobby].forEach(cleanup);
  }
});

test('update: work→hobby keeps every file byte-identical and says they are no longer maintained', async () => {
  const cwd = scratch();
  const dir = project('work');
  try {
    await update({ behind: 2, projects: [dir], cwd });
    const before = snapshot(dir);
    assert.equal(Object.keys(before).length, PORTABLE.length + HANDOFF_FILES.length);
    writeConfig(dir, 'hobby');
    const { log, handoffCalls } = await update({ behind: 2, projects: [dir], cwd });
    assert.equal(handoffCalls.length, 0);
    assert.match(log, /skipped — project mode is hobby .*existing files are no longer maintained.*nothing is deleted/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    [cwd, dir].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- persisted provisioning state
// Sol review of S1, item 1: the already-current path must not infer completeness
// from "some files exist". The completion marker records each project's last
// provisioning ({mode, head, outcome, config}); a work project whose record is
// missing, not work, or at another head is re-provisioned even when files exist,
// and the portable-agent set and the registered docs/sterling files are checked
// EXACTLY.

const NOW = '2026-09-25T12:00:00.000Z';
function addArticle(dir, slug) {
  const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  s.create({
    id: `aaaaaaaa-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`, // not-a-citation: fixture id
    type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [], slug,
    title: `Area ${slug}`, what_it_does: `Does ${slug}.`, intended_behavior: 'Works.',
    files: [{ path: `src/${slug}.ts`, role: 'the code' }],
    current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', history: [{ date: NOW, event: 'created' }], live_test_refs: [],
  });
  s.close();
}
const docsFiles = (dir) => (existsSync(join(dir, 'docs', 'sterling', 'articles')) ? readdirSync(join(dir, 'docs', 'sterling', 'articles')).sort() : []);
const markerOf = (cwd) => JSON.parse(readFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), 'utf8'));

test('update, HEAD unchanged: a work→hobby→work cycle re-provisions stale files even though every file exists', async () => {
  const cwd = scratch();
  const dir = project('work');
  try {
    addArticle(dir, 'first');
    await update({ behind: 2, projects: [dir], cwd });
    assert.deepEqual(markerOf(cwd).projects?.[dir]?.mode, 'work', 'the marker records the work provisioning');
    writeConfig(dir, 'hobby');
    await update({ behind: 2, projects: [dir], cwd }); // a full update while hobby: the files go stale
    assert.equal(markerOf(cwd).projects?.[dir]?.mode, 'hobby');
    addArticle(dir, 'second');
    writeConfig(dir, 'work');
    const r = await update({ behind: 0, projects: [dir], cwd });
    assert.equal(r.report.exit, 0, r.log);
    assert.deepEqual(r.handoffCalls.map((c) => c.split(' ').pop()), [dir], 'the stale project is re-projected');
    assert.match(readFileSync(join(dir, 'architecture.md'), 'utf8'), /Area second/, 'the projection is current again');
  } finally {
    [cwd, dir].forEach(cleanup);
  }
});

test('update, HEAD unchanged: a PARTIAL portable-agent set is not complete — the missing agent is restored', async () => {
  const cwd = scratch();
  const dir = project('work');
  try {
    await update({ behind: 2, projects: [dir], cwd });
    rmSync(join(dir, '.opencode', 'agents', 'scout.md'));
    const r = await update({ behind: 0, projects: [dir], cwd });
    assert.equal(r.report.exit, 0, r.log);
    assert.deepEqual(opencodeFiles(dir), PORTABLE.map((n) => `${n}.md`));
  } finally {
    [cwd, dir].forEach(cleanup);
  }
});

test('update, HEAD unchanged: a missing registered docs/sterling file is not complete — it is restored', async () => {
  const cwd = scratch();
  const dir = project('work');
  try {
    addArticle(dir, 'kept');
    await update({ behind: 2, projects: [dir], cwd });
    const [doc] = docsFiles(dir);
    assert.ok(doc, 'the article was projected');
    rmSync(join(dir, 'docs', 'sterling', 'articles', doc));
    const r = await update({ behind: 0, projects: [dir], cwd });
    assert.equal(r.report.exit, 0, r.log);
    assert.deepEqual(docsFiles(dir), [doc]);
  } finally {
    [cwd, dir].forEach(cleanup);
  }
});

test('update, HEAD unchanged: a fully provisioned work project is a no-op', async () => {
  const cwd = scratch();
  const dir = project('work');
  try {
    addArticle(dir, 'steady');
    await update({ behind: 2, projects: [dir], cwd });
    const before = snapshot(dir);
    const r = await update({ behind: 0, projects: [dir], cwd });
    assert.equal(r.report.exit, 0, r.log);
    assert.equal(r.handoffCalls.length + r.syncCalls.length, 0, r.log);
    assert.match(r.log, /Already current/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    [cwd, dir].forEach(cleanup);
  }
});
