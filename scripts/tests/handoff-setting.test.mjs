// The handoff setting (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// config.handoff.enabled decides whether Sterling writes the portable OpenCode
// agents and the handoff projection. config.mode decides only how work ships.
// Every gate is run over the four combinations hobby/work x handoff on/off: the
// files follow the key in both modes, and the shipping flow follows the mode
// with the key on and off.
// init's arms live in init-ensure.test.mjs, the H1 banner in
// h1-project-mode-line.test.mjs and /sterling:merge in
// direct-merge-work-mode.test.mjs (each needs that file's harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as handoffLib from '../lib/handoff-projection.mjs';
import { ensureExcluded } from '../lib/opencode-install.mjs';
import { runUpdate } from '../lib/update.mjs';
import { armPrLoop } from '../lib/work-pr.mjs';
import { evaluatePrLoop } from '../hooks/lib/pr-loop-duty.mjs';
import { operatingStateLines } from '../../packages/opencode-plugin/src/operating-state.mjs';

const { readHandoffEnabled, HandoffSettingError, HANDOFF_OFF_DETAIL } = handoffLib;
// Read off the namespace so a missing export fails the test that needs it, not the whole file.
const { HandoffGitError, trackedHandoffFiles, handoffFilesOnDisk, HANDOFF_MARKER } = handoffLib;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);

const PORTABLE = ['implementor', 'researcher', 'scout'];
const HANDOFF_FILES = ['architecture.md', 'rulings.md'];
const COMBOS = [['hobby', true], ['hobby', false], ['work', true], ['work', false]];
const label = (mode, on) => `${mode}, handoff ${on ? 'on' : 'off'}`;
// `npm test` switches the real OpenCode setup off through its preload; a targeted
// run of this file has no preload, so the spawns set it themselves.
const cliEnv = { ...process.env, STERLING_OPENCODE_SETUP_DISABLE: '1' };

const git = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function gitInit(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}
// `handoff` is written verbatim as config.handoff when given; undefined leaves the key out.
function project({ mode, handoff, store = true, repo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-setting-'));
  if (repo) gitInit(dir);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, { mode, handoff });
  if (store) new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}
function writeConfig(dir, { mode, handoff }) {
  const cfg = { project_name: 'fixture', ...(mode === undefined ? {} : { mode }), ...(handoff === undefined ? {} : { handoff }) };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
const combo = (mode, on, extra = {}) => project({ mode, handoff: { enabled: on }, ...extra });
const opencodeFiles = (dir) => (existsSync(join(dir, '.opencode', 'agents')) ? readdirSync(join(dir, '.opencode', 'agents')).sort() : []);
const handoffFiles = (dir) => HANDOFF_FILES.filter((f) => existsSync(join(dir, f)));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const syncAgents = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir, env: cliEnv });
const handoffCli = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'handoff-projection.mjs'), dir], { encoding: 'utf8', cwd: dir, env: cliEnv });

// ---------------------------------------------------------------- the reader

test('readHandoffEnabled: no config, no key, or a handoff block without `enabled` is off; true and false are read as declared', () => {
  const none = mkdtempSync(join(tmpdir(), 'sterling-handoff-none-'));
  const dirs = [none, project({ store: false }), project({ handoff: {}, store: false }), project({ handoff: { enabled: true }, store: false }), project({ handoff: { enabled: false }, store: false })];
  try {
    assert.deepEqual(dirs.map((d) => readHandoffEnabled(d)), [false, false, false, true, false]);
  } finally {
    dirs.forEach(cleanup);
  }
});

test('readHandoffEnabled: the mode is never consulted', () => {
  const dirs = COMBOS.map(([mode, on]) => combo(mode, on, { store: false }));
  const badMode = project({ mode: 'Work', handoff: { enabled: true }, store: false });
  try {
    assert.deepEqual(dirs.map((d) => readHandoffEnabled(d)), [true, false, true, false]);
    assert.equal(readHandoffEnabled(badMode), true, 'an invalid mode does not change the handoff answer');
  } finally {
    [...dirs, badMode].forEach(cleanup);
  }
});

test('readHandoffEnabled: with no key, portable agents TRACKED in git mean on; untracked ones do not; an explicit false wins', () => {
  const tracked = project({ mode: 'hobby', store: false, repo: true });
  const untracked = project({ mode: 'work', store: false, repo: true });
  const noRepo = project({ store: false });
  try {
    for (const dir of [tracked, untracked, noRepo]) {
      mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
    }
    git(tracked, ['add', '.opencode/agents/scout.md']);
    git(tracked, ['commit', '-qm', 'portable']);
    assert.equal(readHandoffEnabled(tracked), true, 'one tracked portable agent is enough');
    assert.equal(readHandoffEnabled(untracked), false, 'a file on disk that git does not track is not a committed handoff');
    assert.equal(readHandoffEnabled(noRepo), false, 'outside a git work tree nothing is tracked');
    writeConfig(tracked, { mode: 'hobby', handoff: { enabled: false } });
    assert.equal(readHandoffEnabled(tracked), false, 'an explicit false is the user turning it off');
    writeConfig(tracked, { mode: 'hobby', handoff: {} });
    assert.equal(readHandoffEnabled(tracked), true, 'a handoff block without `enabled` is still an absent key');
  } finally {
    [tracked, untracked, noRepo].forEach(cleanup);
  }
});

test('readHandoffEnabled: a non-boolean value or an unparseable config is refused with HandoffSettingError, naming the value', () => {
  const dir = project({ store: false });
  try {
    assert.equal(typeof HandoffSettingError, 'function');
    for (const raw of ['yes', 'true', 1, 0, null, ['on'], {}]) {
      writeConfig(dir, { handoff: { enabled: raw } });
      assert.throws(() => readHandoffEnabled(dir), (e) => e instanceof HandoffSettingError && e.message.includes(JSON.stringify(raw)) && /true or false/.test(e.message), `enabled ${JSON.stringify(raw)} refused`);
    }
    for (const raw of ['on', true, 1, null, [true]]) {
      writeConfig(dir, { handoff: raw });
      assert.throws(() => readHandoffEnabled(dir), (e) => e instanceof HandoffSettingError && e.message.includes(JSON.stringify(raw)), `handoff ${JSON.stringify(raw)} refused`);
    }
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    assert.throws(() => readHandoffEnabled(dir), (e) => e instanceof HandoffSettingError && /not valid JSON/.test(e.message));
    writeFileSync(join(dir, '.sterling', 'config.json'), '[]');
    assert.throws(() => readHandoffEnabled(dir), (e) => e instanceof HandoffSettingError && /not a JSON object/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test('the skip text says what is true: it names the setting and never calls the files work-only', () => {
  assert.equal(typeof HANDOFF_OFF_DETAIL, 'string');
  assert.match(HANDOFF_OFF_DETAIL, /config\.handoff\.enabled/);
  assert.match(HANDOFF_OFF_DETAIL, /nothing is deleted/);
  assert.doesNotMatch(HANDOFF_OFF_DETAIL, /work-only|hobby|work mode/);
  assert.equal(handoffLib.HOBBY_SKIP_DETAIL, undefined, 'the old constant is renamed, not kept beside the new one');
});

// ---------------------------------------------------------------- handoff-projection CLI

for (const [mode, on] of COMBOS) {
  test(`handoff CLI (${label(mode, on)}): ${on ? 'projects' : 'is a STANDING refusal (exit 2) that writes nothing'}`, () => {
    const dir = combo(mode, on);
    try {
      const r = handoffCli(dir);
      if (on) {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^handoff projection: written/m);
        assert.deepEqual(handoffFiles(dir), HANDOFF_FILES);
      } else {
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stdout, /^handoff projection: REFUSED — handoff files are off \(config\.handoff\.enabled/m);
        assert.deepEqual(handoffFiles(dir), []);
        assert.ok(!existsSync(join(dir, 'docs')));
      }
    } finally {
      cleanup(dir);
    }
  });
}

test('handoff CLI: a non-boolean setting is an ACTIONABLE refusal (exit 3) naming the value; an invalid MODE is not its business', () => {
  const bad = project({ mode: 'work', handoff: { enabled: 'yes' } });
  const badMode = project({ mode: 'hobbyist', handoff: { enabled: true } });
  try {
    const r = handoffCli(bad);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^handoff projection: REFUSED — .*"yes"/m);
    assert.deepEqual(handoffFiles(bad), []);
    const m = handoffCli(badMode);
    assert.equal(m.status, 0, m.stdout + m.stderr);
    assert.deepEqual(handoffFiles(badMode), HANDOFF_FILES, 'the projection reads the handoff key, never the mode');
  } finally {
    [bad, badMode].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- sync-agents

for (const [mode, on] of COMBOS) {
  test(`sync-agents (${label(mode, on)}): ${on ? 'writes the portable agents' : 'skips the portable agents with a loud line'}; the Claude agents sync either way`, () => {
    const dir = combo(mode, on);
    try {
      const r = syncAgents(dir);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^installed: implementor$/m, 'the Claude Code agents do not depend on the setting');
      if (on) {
        for (const name of PORTABLE) assert.match(r.stdout, new RegExp(`^installed: \\.opencode/agents/${name}\\.md$`, 'm'));
        assert.deepEqual(opencodeFiles(dir), PORTABLE.map((n) => `${n}.md`));
      } else {
        assert.match(r.stdout, /^portable agents \(\.opencode\/agents\/\) SKIPPED — handoff files are off \(config\.handoff\.enabled/m);
        assert.doesNotMatch(r.stdout, /\.opencode\/agents\/\w+\.md/);
        assert.deepEqual(opencodeFiles(dir), []);
      }
    } finally {
      cleanup(dir);
    }
  });
}

test('sync-agents: a non-boolean handoff setting refuses the sync (exit 2), naming the value', () => {
  const dir = project({ mode: 'work', handoff: { enabled: 'yes' } });
  try {
    const r = syncAgents(dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^refused_handoff_setting: .*"yes".*nothing synced/m);
    assert.deepEqual(opencodeFiles(dir), []);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- /sterling:update fan-out

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
// git and npm are faked; sync-agents and handoff-projection run for real against the temp targets.
function updateExec() {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged ? '0\t0' : '2\t0');
      if (a === 'status --porcelain') return ok('');
      if (a.startsWith('merge --ff-only')) { merged = true; return ok('Fast-forward'); }
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    const script = args[0]?.split(/[\\/]/).pop();
    if (script === 'sync-agents.mjs' || script === 'handoff-projection.mjs') {
      const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args.slice(1)], { encoding: 'utf8', env: cliEnv });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (script === 'stamp-contract.mjs') return ok('0 refusal(s).\n');
    return ok('done');
  };
  return { exec, calls };
}
async function update(projects) {
  const cwd = mkdtempSync(join(tmpdir(), 'sterling-handoff-update-cwd-'));
  const { exec, calls } = updateExec();
  const lines = [];
  try {
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: projects.map((p) => ({ name: p.split(/[\\/]/).pop(), repo_path: p })), opts: {} });
    return { report, log: lines.join('\n'), handoffCalls: calls.filter((c) => c.includes('handoff-projection.mjs')), syncCalls: calls.filter((c) => c.includes('sync-agents.mjs')) };
  } finally {
    cleanup(cwd);
  }
}

test('update fan-out: all four combinations in one run — both file sets for handoff on, a loud skip and no files for handoff off, whatever the mode', async () => {
  const dirs = COMBOS.map(([mode, on]) => combo(mode, on));
  try {
    const { report, log, handoffCalls, syncCalls } = await update(dirs);
    assert.equal(report.exit, 0, log);
    assert.equal(syncCalls.length, 4, 'every project is synced');
    assert.deepEqual(handoffCalls.map((c) => c.split(' ').pop()), dirs.filter((_, i) => COMBOS[i][1]), 'the projection runs only where handoff is on');
    assert.deepEqual(report.projects.map((p) => p.handoff), [0, 'skipped', 0, 'skipped']);
    assert.equal(log.match(/skipped — handoff files are off \(config\.handoff\.enabled/g)?.length, 2);
    COMBOS.forEach(([mode, on], i) => {
      assert.deepEqual(opencodeFiles(dirs[i]), on ? PORTABLE.map((n) => `${n}.md`) : [], `${label(mode, on)}: portable agents`);
      assert.deepEqual(handoffFiles(dirs[i]), on ? HANDOFF_FILES : [], `${label(mode, on)}: handoff indexes`);
    });
  } finally {
    dirs.forEach(cleanup);
  }
});

test('update fan-out: a non-boolean handoff setting is its own refusal class; nothing is synced for that project and the others proceed', async () => {
  const bad = project({ mode: 'work', handoff: { enabled: 'yes' } });
  const fine = combo('hobby', true);
  try {
    const { report, log, handoffCalls, syncCalls } = await update([bad, fine]);
    assert.equal(report.exit, 2, log);
    assert.match(log, /✗ .*REFUSED — handoff setting: config\.handoff\.enabled is "yes"/);
    assert.doesNotMatch(log, /REFUSED — project mode/, 'never mislabelled as a mode refusal');
    assert.deepEqual(report.projects.map((p) => p.handoff), ['refused_handoff_setting', 0]);
    assert.deepEqual([syncCalls.length, handoffCalls.length], [1, 1], 'only the valid project is synced and projected');
    assert.deepEqual(handoffFiles(fine), HANDOFF_FILES);
  } finally {
    [bad, fine].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- the git exclude block

const excludeOf = (dir) => readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');

for (const [mode, on] of COMBOS) {
  test(`exclude block (${label(mode, on)}, nothing tracked under .opencode/): ${on ? "only Sterling's own paths" : 'the whole directory'}`, () => {
    const dir = combo(mode, on, { store: false, repo: true });
    try {
      const row = ensureExcluded({ projectDir: dir, handoff: readHandoffEnabled(dir), tracked: [] });
      assert.equal(row.status, 'created');
      if (on) {
        assert.doesNotMatch(excludeOf(dir), /^\/\.opencode\/$/m, 'the portable agents must stay visible to git');
        assert.match(excludeOf(dir), /^\/\.opencode\/opencode\.json$/m);
        assert.match(excludeOf(dir), /^\/\.opencode\/agents\/sterling\/$/m);
      } else {
        assert.match(excludeOf(dir), /^\/\.opencode\/$/m);
      }
    } finally {
      cleanup(dir);
    }
  });
}

test('exclude block: handoff off with something tracked under .opencode/, or an unreadable setting, still gets the narrow block', () => {
  const tracked = combo('hobby', false, { store: false, repo: true });
  const unknown = combo('hobby', false, { store: false, repo: true });
  try {
    ensureExcluded({ projectDir: tracked, handoff: false, tracked: ['.opencode/notes.md'] });
    assert.doesNotMatch(excludeOf(tracked), /^\/\.opencode\/$/m);
    ensureExcluded({ projectDir: unknown, handoff: null, tracked: [] });
    assert.doesNotMatch(excludeOf(unknown), /^\/\.opencode\/$/m, 'an unknown setting never hides committed portable agents');
  } finally {
    [tracked, unknown].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- the shipping flow follows the mode

for (const [mode, on] of COMBOS) {
  test(`PR review loop duty (${label(mode, on)}): an armed loop is ${mode === 'work' ? 'owed' : 'not owed'}`, () => {
    const dir = combo(mode, on, { store: false });
    try {
      armPrLoop(dir, { pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, repo: 'acme/widget', head_sha: HEAD_A });
      const { state, degraded } = evaluatePrLoop(dir);
      assert.equal(degraded, null);
      if (mode === 'work') assert.equal(state?.pr_number, 7, 'a work project owes the loop with handoff on and off');
      else assert.equal(state, null, 'a hobby project owes no loop with handoff on and off');
    } finally {
      cleanup(dir);
    }
  });
}

// ---------------------------------------------------------------- the OpenCode banner

const lineOf = (lines, prefix) => lines.filter((l) => l.startsWith(prefix));
const MODE_TEXT = {
  work: 'Project mode: WORK (config.mode — TUI System tab) — work ships as a pull request through /sterling:merge, followed by the review loop; nothing is merged directly.',
  hobby: 'Project mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.',
};
const HANDOFF_TEXT = {
  true: 'Handoff files: ON (config.handoff.enabled — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are written and maintained.',
  false: 'Handoff files: OFF (config.handoff.enabled — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.',
};

for (const [mode, on] of COMBOS) {
  test(`OpenCode banner (${label(mode, on)}): the mode line says only how work ships; a separate line says whether the handoff files are written`, () => {
    const dir = combo(mode, on, { store: false });
    try {
      const { lines } = operatingStateLines(dir, null);
      assert.deepEqual(lineOf(lines, 'Project mode:'), [MODE_TEXT[mode]]);
      assert.deepEqual(lineOf(lines, 'Handoff files:'), [HANDOFF_TEXT[on]]);
      assert.doesNotMatch(lines.join('\n'), /work-only/);
      assert.doesNotMatch(lineOf(lines, 'Project mode:')[0], /OpenCode|handoff/i, 'the mode line makes no claim about the handoff files');
      assert.equal(lines.indexOf(HANDOFF_TEXT[on]), lines.indexOf(MODE_TEXT[mode]) + 1, 'the handoff line follows the mode line');
    } finally {
      cleanup(dir);
    }
  });
}

test('OpenCode banner: tracked portable agents with no key read ON and say why; a non-boolean reads INVALID; an unreadable config reads UNKNOWN', () => {
  const tracked = project({ mode: 'hobby', store: false, repo: true });
  const bad = project({ mode: 'work', handoff: { enabled: 'yes' }, store: false });
  const broken = project({ store: false });
  try {
    mkdirSync(join(tracked, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(tracked, '.opencode', 'agents', 'implementor.md'), 'portable\n');
    git(tracked, ['add', '.opencode']);
    git(tracked, ['commit', '-qm', 'portable']);
    assert.deepEqual(lineOf(operatingStateLines(tracked, null).lines, 'Handoff files:'), [
      'Handoff files: ON (config.handoff.enabled is not set; handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are written and maintained.',
    ]);
    assert.deepEqual(lineOf(operatingStateLines(bad, null).lines, 'Handoff files:'), [
      "Handoff files: INVALID ('yes') — config.handoff.enabled must be true or false; init, sync-agents, /sterling:update and the handoff projection refuse to act on it until it is fixed (TUI System tab).",
    ]);
    writeFileSync(join(broken, '.sterling', 'config.json'), '{ not json');
    assert.deepEqual(lineOf(operatingStateLines(broken, null).lines, 'Handoff files:'), [
      'Handoff files: UNKNOWN — the project config could not be read, so config.handoff.enabled could not be determined. This is NOT the off default: repair the config.',
    ]);
  } finally {
    [tracked, bad, broken].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- git could not answer (review round 2)
//
// An absent key asks git whether handoff files are committed. "Not a git work
// tree" is an answer (nothing tracked). Any other git failure is NOT: the reader
// throws, the writers refuse naming the git error, and the banner reads UNKNOWN.

const NOT_SET_OFF = 'Handoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.';
const UNKNOWN_GIT = /^Handoff files: UNKNOWN — config\.handoff\.enabled is not set and git could not say whether handoff files are committed \(git ls-files exited 128: [^)]+\)\. This is NOT the off default: init, sync-agents, \/sterling:update and the handoff projection refuse to act until git answers or the setting is set \(TUI System tab\)\.$/;

function commitFile(dir, rel, content) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
  git(dir, ['add', '--', rel]);
  git(dir, ['commit', '-qm', `add ${rel}`]);
}
// A repo with a committed portable agent, no handoff key, and an index git cannot read.
function corruptIndexProject(extra = {}) {
  const dir = project({ mode: 'work', repo: true, ...extra });
  commitFile(dir, '.opencode/agents/scout.md', 'portable\n');
  writeFileSync(join(dir, '.git', 'index'), 'not an index');
  return dir;
}

test('git failure: a corrupt index with a committed portable agent and no key throws HandoffGitError naming the git error; an explicit key never asks git', () => {
  const dir = corruptIndexProject({ store: false });
  try {
    assert.equal(typeof HandoffGitError, 'function');
    assert.throws(() => readHandoffEnabled(dir), (err) => {
      assert.ok(err instanceof HandoffGitError, `HandoffGitError, got ${err?.constructor?.name}: ${err?.message}`);
      assert.ok(err instanceof HandoffSettingError, 'a subclass, so every writer that refuses an invalid setting refuses this too');
      assert.match(err.message, /config\.handoff\.enabled is not set/);
      assert.match(err.message, /git ls-files exited 128/);
      return true;
    });
    writeConfig(dir, { mode: 'work', handoff: { enabled: false } });
    assert.equal(readHandoffEnabled(dir), false);
    writeConfig(dir, { mode: 'work', handoff: { enabled: true } });
    assert.equal(readHandoffEnabled(dir), true);
  } finally {
    cleanup(dir);
  }
});

test('trackedHandoffFiles is three-state: outside a work tree nothing is tracked; a missing git, a timeout or a broken .git is unknown with the reason', () => {
  const noRepo = project({ store: false });
  const brokenGit = project({ store: false });
  try {
    assert.equal(typeof trackedHandoffFiles, 'function');
    assert.deepEqual(trackedHandoffFiles(noRepo), { files: [], unknown: null });
    assert.deepEqual(trackedHandoffFiles(join(noRepo, 'gone')), { files: [], unknown: null }, 'a directory that does not exist holds nothing; that is not a missing git');
    const seen = [];
    const timedOut = trackedHandoffFiles(noRepo, { spawn: (cmd, args, opts) => { seen.push(opts); return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }; } });
    assert.deepEqual(timedOut.files, []);
    assert.match(timedOut.unknown, /^git rev-parse timed out after 30s$/);
    assert.equal(seen[0].timeout, 30_000, 'the same timeout gitIgnored uses');
    const missing = trackedHandoffFiles(noRepo, { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }) }) });
    assert.match(missing.unknown, /^git rev-parse did not run \(spawnSync git ENOENT\)$/);
    mkdirSync(join(brokenGit, '.git'));
    assert.match(trackedHandoffFiles(brokenGit).unknown, /^git rev-parse exited 128: .*not a git repository/, 'a .git that git cannot use is not "no repository"');
    assert.throws(() => readHandoffEnabled(brokenGit), HandoffGitError);
  } finally {
    [noRepo, brokenGit].forEach(cleanup);
  }
});

test('readHandoffEnabled: with no key, a committed handoff projection counts as on without any portable agent — docs/sterling/ files and marked root indexes; an unmarked root file does not', () => {
  const marked = `${HANDOFF_MARKER} from this project's knowledge store — DO NOT EDIT. -->\n# Architecture\n`;
  const cases = [
    ['docs/sterling/articles/a-12345678.md', '# A\n', true],
    ['architecture.md', marked, true],
    ['rulings.md', marked, true],
    ['architecture.md', '# our own architecture notes\n', false],
    ['docs/other/notes.md', '# notes\n', false],
  ];
  for (const [rel, content, expected] of cases) {
    const dir = project({ mode: 'hobby', store: false, repo: true });
    try {
      commitFile(dir, rel, content);
      assert.equal(readHandoffEnabled(dir), expected, `${rel} (${expected ? 'handoff already committed' : 'not a handoff file'})`);
      assert.deepEqual(trackedHandoffFiles(dir), { files: expected ? [rel] : [], unknown: null });
    } finally {
      cleanup(dir);
    }
  }
});

test('git failure: sync-agents refuses (exit 2) and the handoff CLI refuses (exit 3), each naming the git error; nothing is written', () => {
  const dir = corruptIndexProject();
  try {
    const s = syncAgents(dir);
    assert.equal(s.status, 2, s.stdout + s.stderr);
    assert.match(s.stdout, /^refused_handoff_setting: .*git ls-files exited 128.*nothing synced/m);
    assert.ok(!existsSync(join(dir, '.claude', 'agents')), 'nothing synced');
    const c = handoffCli(dir);
    assert.equal(c.status, 3, c.stdout + c.stderr);
    assert.match(c.stdout + c.stderr, /git ls-files exited 128/);
    assert.deepEqual(handoffFiles(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('git failure: the update fan-out refuses that project naming the git error and the others proceed', async () => {
  const bad = corruptIndexProject();
  const fine = combo('hobby', true);
  try {
    const { report, log, syncCalls, handoffCalls } = await update([bad, fine]);
    assert.equal(report.exit, 2, log);
    assert.match(log, /✗ .*REFUSED — handoff setting: .*git ls-files exited 128/);
    assert.deepEqual(report.projects.map((p) => p.handoff), ['refused_handoff_setting', 0]);
    assert.deepEqual([syncCalls.length, handoffCalls.length], [1, 1]);
  } finally {
    [bad, fine].forEach(cleanup);
  }
});

test('OpenCode banner: a git failure with no key reads UNKNOWN with the reason, never OFF; an absent key with nothing tracked reads OFF (not set), distinct from an explicit false', () => {
  const bad = corruptIndexProject({ store: false });
  const notSet = project({ mode: 'work', store: false });
  const explicit = combo('work', false, { store: false });
  try {
    const badLines = lineOf(operatingStateLines(bad, null).lines, 'Handoff files:');
    assert.equal(badLines.length, 1);
    assert.match(badLines[0], UNKNOWN_GIT);
    assert.doesNotMatch(badLines[0], /Handoff files: (ON|OFF)\b/);
    assert.deepEqual(lineOf(operatingStateLines(notSet, null).lines, 'Handoff files:'), [NOT_SET_OFF]);
    assert.deepEqual(lineOf(operatingStateLines(explicit, null).lines, 'Handoff files:'), [HANDOFF_TEXT.false]);
  } finally {
    [bad, notSet, explicit].forEach(cleanup);
  }
});

// ---------------------------------------------------------------- files on disk that nothing maintains

const UNMAINTAINED = /handoff files NOT MAINTAINED — \.opencode\/agents\/scout\.md, docs\/sterling\/ (exist|exists) on disk, not tracked in git, and config\.handoff\.enabled is not set: Sterling no longer maintains them and deletes nothing\. Turn on the Handoff files row in the TUI System tab to keep them maintained\./;
function untrackedHandoffProject(extra = {}) {
  const dir = project({ mode: 'work', repo: true, ...extra });
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
  mkdirSync(join(dir, 'docs', 'sterling', 'articles'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'sterling', 'articles', 'a.md'), '# A\n');
  return dir;
}

test('handoffFilesOnDisk lists the portable agents, docs/sterling/ and marked root indexes present on disk', () => {
  const dir = untrackedHandoffProject({ store: false });
  try {
    assert.equal(typeof handoffFilesOnDisk, 'function');
    writeFileSync(join(dir, 'architecture.md'), `${HANDOFF_MARKER} -->\n`);
    writeFileSync(join(dir, 'rulings.md'), '# hand-written\n');
    assert.deepEqual(handoffFilesOnDisk(dir), ['.opencode/agents/scout.md', 'docs/sterling/', 'architecture.md']);
  } finally {
    cleanup(dir);
  }
});

test('no key, untracked handoff files on disk: sync-agents and the update fan-out each print one line naming them; an explicit false or a clean project prints none', async () => {
  const dir = untrackedHandoffProject();
  const explicit = untrackedHandoffProject({ handoff: { enabled: false } });
  const clean = project({ mode: 'work', repo: true });
  try {
    const s = syncAgents(dir);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.equal(s.stdout.match(new RegExp(UNMAINTAINED, 'g'))?.length, 1, s.stdout);
    assert.doesNotMatch(s.stdout, /^[a-z_]+: .*NOT MAINTAINED/m, "never shaped like an agent status line, which the update fan-out would count as a change");
    for (const other of [explicit, clean]) assert.doesNotMatch(syncAgents(other).stdout, /NOT MAINTAINED/);
    const { report, log } = await update([dir, explicit, clean]);
    assert.equal(report.exit, 0, log);
    assert.equal(log.match(new RegExp(UNMAINTAINED, 'g'))?.length, 1, log);
    assert.equal(readFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'utf8'), 'portable\n', 'nothing is rewritten or deleted');
  } finally {
    [dir, explicit, clean].forEach(cleanup);
  }
});

test('exclude block: untracked portable agents on disk with no key keep the block narrow, so git status still shows them', () => {
  const dir = untrackedHandoffProject({ store: false });
  try {
    ensureExcluded({ projectDir: dir, handoff: false, tracked: [], unmaintained: ['.opencode/agents/scout.md'] });
    assert.doesNotMatch(excludeOf(dir), /^\/\.opencode\/$/m);
    assert.match(git(dir, ['status', '--short', '--untracked-files=all']), /\.opencode\/agents\/scout\.md/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- upgrade: { mode: 'work' }, no key, portable agents committed

// A project from before the setting existed: real portable agents written by
// sync-agents and committed, then the handoff key removed from the config.
function upgradedProject() {
  const dir = project({ mode: 'work', handoff: { enabled: true }, repo: true });
  const first = syncAgents(dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  git(dir, ['add', '.opencode/agents/implementor.md', '.opencode/agents/researcher.md', '.opencode/agents/scout.md']);
  git(dir, ['commit', '-qm', 'portable agents']);
  writeConfig(dir, { mode: 'work' });
  rmSync(join(dir, '.opencode', 'agents', 'researcher.md'));
  return dir;
}

test('upgrade through sync-agents: { mode: work }, no handoff key, portable agents committed — they are still maintained', () => {
  const dir = upgradedProject();
  try {
    const r = syncAgents(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^installed: \.opencode\/agents\/researcher\.md$/m);
    assert.match(r.stdout, /^up_to_date: \.opencode\/agents\/scout\.md$/m);
    assert.doesNotMatch(r.stdout, /SKIPPED — handoff files are off|NOT MAINTAINED/);
    assert.deepEqual(opencodeFiles(dir).filter((f) => f.endsWith('.md')), PORTABLE.map((n) => `${n}.md`));
  } finally {
    cleanup(dir);
  }
});

test('upgrade through /sterling:update: { mode: work }, no handoff key, portable agents committed — the agents and the projection are written', async () => {
  const dir = upgradedProject();
  try {
    const { report, log, handoffCalls } = await update([dir]);
    assert.equal(report.exit, 0, log);
    assert.deepEqual(report.projects.map((p) => p.handoff), [0]);
    assert.equal(handoffCalls.length, 1);
    assert.doesNotMatch(log, /handoff files are off|NOT MAINTAINED/);
    assert.ok(existsSync(join(dir, '.opencode', 'agents', 'researcher.md')), 'the missing portable agent is rewritten');
    assert.deepEqual(handoffFiles(dir), HANDOFF_FILES);
  } finally {
    cleanup(dir);
  }
});
