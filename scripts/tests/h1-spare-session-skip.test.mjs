// H1 SessionStart — DAEMON SPARE SKIP (decision h1-skips-a-claude-code-daemon-spare-session,
// finding claude-code-daemon-spare-session-fires-sessionstart-in-the-project-october-2026).
// Claude Code's background supervisor keeps an idle, pre-warmed spare session beside the real one,
// and a named spare runs the project's SessionStart hook. H1 writes session.json, deletes the
// dispatch register and resets the transient registers at that event, so a spare's SessionStart
// took a live session's state. The guard reads <claude dir>/sessions/*.json: when the entry whose
// sessionId equals the hook's session_id carries spare:true, H1 prints one line and does nothing
// else. Every other shape (no directory, no matching file, a malformed file, a non-boolean spare)
// runs H1 as before. A claimed spare fires SessionStart again without the key, so it is not lost.
// The hook is run from SOURCE with a fake HOME and CLAUDE_CONFIG_DIR; nothing real is read.
// Harness shape from scripts/tests/h1-codex-registration-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SESSION_FILE_CAP, SPARE_SKIP_LINE, claudeSessionsDir, isSpareSession } from '../hooks/lib/claude-session-kind.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

const LIVE = 'live-session-c0410298';
const SPARE = 'spare-session-12a42dc5';
const AT = '2026-10-04T17:48:09.000Z';
const PROMPT = 'implement the thing';

const temps = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// A git project with a Sterling store and a live session's transient state, under the real file
// names H1 and its libs read. gitSettled:false leaves the snapshot absent, the state in which a
// startup or clear H1 creates it.
function project({ gitSettled = false } = {}) {
  const dir = tmp('sterling-h1-spare-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  git(dir, ['add', 'a.mjs']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const transient = join(dir, '.sterling', 'transient');
  mkdirSync(join(transient, 'dispatch-state'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  const put = (name, value) => writeFileSync(join(transient, name), JSON.stringify(value));
  put('session.json', { session_id: LIVE, source: 'startup', at: AT });
  put('dispatch-register.json', [{ agent_id: 'agent-live-1', session_id: LIVE, agent_type: 'implementor', files: ['a.mjs'], at: AT }]);
  put(join('dispatch-state', 'live-toolu_live1.json'), {
    schema: 1,
    tool_use_id: 'toolu_live1',
    session_id: LIVE,
    origin: 'pre',
    prompt_bytes: Buffer.byteLength(PROMPT, 'utf8'),
    prompt_sha256: createHash('sha256').update(PROMPT, 'utf8').digest('hex'),
    prompt: PROMPT,
  });
  put('touches.json', [{ path: 'a.mjs', at: AT }]);
  put('session-events.json', [{ kind: 'capture_pending', detail: 'article update owed', at: AT }]);
  put('capture-nagged.json', { at: AT });
  put('conductor-reads.json', [{ path: 'a.mjs', sha256: 'x', at: AT }]);
  put('rotation-note.json', { plan_path: null, next_slice: 'carry on', lanes: ['lane one'], session_id: LIVE, objective: null, risks: null, pointers: null, live_dispatches: [], uncertain_dispatches: [], reason: 'rotation', at: AT });
  put('plan-lock-released.json', { reason: 'released by hand', at: AT });
  if (gitSettled) put('git-settled.json', { sha: '0'.repeat(40), dirty: {}, at: AT });
  return dir;
}

// Every file under dir except .git, as relative path -> bytes (hex).
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === '.git') continue;
      if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(r);
      } else out[r] = readFileSync(join(dir, r)).toString('hex');
    }
  };
  walk('');
  return out;
}

// sessions: undefined = no sessions directory; else { name: object | string } written verbatim.
function claudeDir(sessions) {
  const cfg = tmp('sterling-h1-spare-cfg-');
  if (sessions !== undefined) {
    mkdirSync(join(cfg, 'sessions'));
    for (const [name, body] of Object.entries(sessions)) writeFileSync(join(cfg, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return cfg;
}

const spareFile = (sessionId, extra = { spare: true }) => ({ pid: 2824593, sessionId, cwd: '/x', kind: 'bg', agent: 'conductor', jobId: sessionId.slice(-8), ...extra, status: 'idle' });
const realFile = (sessionId) => ({ pid: 2824500, sessionId, cwd: '/x', kind: 'interactive', status: 'busy' });

function runH1(dir, { session_id = SPARE, source = 'startup', env }) {
  const input = { session_id, transcript_path: join(dir, 't', `${session_id}.jsonl`), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source };
  return spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root, ...env },
  });
}

// CLAUDE_CONFIG_DIR and HOME both point at fakes, so no real ~/.claude or ~/.sterling is touched.
const fakeEnv = (cfg, home = tmp('sterling-h1-spare-home-')) => ({ CLAUDE_CONFIG_DIR: cfg, HOME: home });

function assertSkipped(dir, r, before, label) {
  assert.equal(r.status, 0, `${label}: exit 0: ${r.stderr}`);
  assert.equal(r.stdout, `${SPARE_SKIP_LINE}\n`, `${label}: the one skip line is the whole stdout`);
  assert.equal(r.stderr, '', `${label}: nothing on stderr`);
  assert.deepEqual(snapshot(dir), before, `${label}: every seeded file is byte-identical and nothing was created`);
}

function assertRanAsToday(dir, r, sessionId, label) {
  assert.equal(r.status, 0, `${label}: exit 0: ${r.stderr}`);
  assert.ok(!r.stdout.includes(SPARE_SKIP_LINE), `${label}: no skip line`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart', label);
  const transient = join(dir, '.sterling', 'transient');
  assert.equal(JSON.parse(readFileSync(join(transient, 'session.json'), 'utf8')).session_id, sessionId, `${label}: session.json names the new session`);
  assert.ok(!existsSync(join(transient, 'dispatch-register.json')), `${label}: the register is deleted`);
  assert.ok(!existsSync(join(transient, 'touches.json')), `${label}: touches.json is cleared`);
  assert.ok(!existsSync(join(transient, 'conductor-reads.json')), `${label}: conductor-reads.json is cleared`);
  assert.ok(!existsSync(join(transient, 'rotation-note.json')), `${label}: the rotation note is consumed`);
  assert.ok(!existsSync(join(transient, 'plan-lock-released.json')), `${label}: the plan-lock marker is claimed`);
  assert.ok(existsSync(join(transient, 'git-settled.json')), `${label}: the git-settled snapshot is seeded`);
  return out;
}

// ------------------------------ the spare case ------------------------------

for (const source of ['startup', 'clear', 'resume', 'compact']) {
  test(`H1 spare skip: source=${source} for a session marked spare:true changes nothing and prints the one skip line`, () => {
    try {
      const dir = project();
      const home = tmp('sterling-h1-spare-home-');
      const cfg = claudeDir({ '2824593.json': spareFile(SPARE), '2824500.json': realFile(LIVE), '2824593.0a1b2c.key': 'not json at all' });
      const before = snapshot(dir);
      const cfgBefore = snapshot(cfg);
      const r = runH1(dir, { source, env: fakeEnv(cfg, home) });
      assertSkipped(dir, r, before, source);
      assert.ok(!existsSync(join(dir, '.sterling', 'transient', 'git-settled.json')), 'no git-settled snapshot was seeded');
      assert.deepEqual(snapshot(cfg), cfgBefore, 'the Claude config dir is read, never written');
      assert.deepEqual(snapshot(home), {}, 'nothing was written under HOME');
    } finally {
      cleanup();
    }
  });
}

test('H1 spare skip: an existing git-settled snapshot is left byte-identical too', () => {
  try {
    const dir = project({ gitSettled: true });
    const cfg = claudeDir({ '2824593.json': spareFile(SPARE) });
    const before = snapshot(dir);
    assertSkipped(dir, runH1(dir, { env: fakeEnv(cfg) }), before, 'git-settled seeded');
  } finally {
    cleanup();
  }
});

test('H1 spare skip: without CLAUDE_CONFIG_DIR the sessions directory is <HOME>/.claude/sessions', () => {
  try {
    const dir = project();
    const home = tmp('sterling-h1-spare-home-');
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'sessions', '2824593.json'), JSON.stringify(spareFile(SPARE)));
    const before = snapshot(dir);
    assertSkipped(dir, runH1(dir, { env: { HOME: home, CLAUDE_CONFIG_DIR: '' } }), before, 'HOME fallback');
  } finally {
    cleanup();
  }
});

// ------------------------- control and fallbacks -------------------------

test('H1 control: the same seed with a sessions file for that id WITHOUT spare runs session start as before', () => {
  try {
    const dir = project();
    const cfg = claudeDir({ '2824593.json': spareFile(SPARE, {}) });
    assertRanAsToday(dir, runH1(dir, { env: fakeEnv(cfg) }), SPARE, 'claimed spare');
  } finally {
    cleanup();
  }
});

// The fixture's temp paths are the only run-to-run difference between two normal H1 runs here.
const normalised = (stdout, dir, cfg, home) => stdout.split(dir).join('<project>').split(cfg).join('<cfg>').split(home).join('<home>');
let control = null;
function controlStdout() {
  if (control === null) {
    const dir = project();
    const cfg = claudeDir({ '2824593.json': spareFile(SPARE, {}) });
    const home = tmp('sterling-h1-spare-home-');
    control = normalised(runH1(dir, { env: fakeEnv(cfg, home) }).stdout, dir, cfg, home);
  }
  return control;
}

const FALLBACKS = [
  ['no sessions directory', undefined],
  ['an empty sessions directory', {}],
  ['spare:true on a file for a DIFFERENT sessionId', { '2824593.json': spareFile('some-other-session') }],
  ['a malformed JSON file next to a valid non-spare one', { '100.json': '{ nope', '2824593.json': spareFile(SPARE, {}) }],
  ['spare: "true" (a string)', { '2824593.json': spareFile(SPARE, { spare: 'true' }) }],
  ['spare: 1', { '2824593.json': spareFile(SPARE, { spare: 1 }) }],
  ['spare:true only inside a .key file', { '2824593.0a1b2c.key': JSON.stringify(spareFile(SPARE)) }],
];
for (const [label, sessions] of FALLBACKS) {
  test(`H1 fallback: ${label} is not a spare, and session start runs as before with no extra line`, () => {
    try {
      const dir = project();
      const cfg = claudeDir(sessions);
      const home = tmp('sterling-h1-spare-home-');
      const r = runH1(dir, { env: fakeEnv(cfg, home) });
      assertRanAsToday(dir, r, SPARE, label);
      assert.equal(normalised(r.stdout, dir, cfg, home), controlStdout(), 'the output is the one a session with an ordinary sessions file gets: no warning, no extra line');
    } finally {
      cleanup();
    }
  });
}

test('H1 fallback: a hook input with no session_id is never a spare', () => {
  try {
    const dir = project();
    const cfg = claudeDir({ '2824593.json': { pid: 1, spare: true } });
    const input = { cwd: dir, hook_event_name: 'SessionStart', source: 'startup' };
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
      input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root, ...fakeEnv(cfg) },
    });
    assertRanAsToday(dir, r, null, 'no session_id');
  } finally {
    cleanup();
  }
});

// ------------------------------ helper units ------------------------------

const helperOpts = (cfg) => ({ env: { CLAUDE_CONFIG_DIR: cfg }, home: '/nonexistent-home' });

test('helper: the sessions directory follows CLAUDE_CONFIG_DIR, else <home>/.claude', () => {
  assert.equal(claudeSessionsDir({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/h' }), join('/cfg', 'sessions'));
  assert.equal(claudeSessionsDir({ env: {}, home: '/h' }), join('/h', '.claude', 'sessions'));
  assert.equal(claudeSessionsDir({ env: { CLAUDE_CONFIG_DIR: '' }, home: '/h' }), join('/h', '.claude', 'sessions'));
});

test('helper: true only for a matching sessionId whose spare is the boolean true', () => {
  try {
    const cfg = claudeDir({ '1.json': realFile(LIVE), '2.json': spareFile(SPARE), '3.json': '{ nope', '4.json': '[1,2]', '5.json': 'null' });
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), true);
    assert.equal(isSpareSession(LIVE, helperOpts(cfg)), false, 'a real session has no spare key');
    assert.equal(isSpareSession('unknown', helperOpts(cfg)), false);
    for (const bad of [undefined, null, '', 42, {}, true]) assert.equal(isSpareSession(bad, helperOpts(cfg)), false, `session_id ${JSON.stringify(bad)}`);
  } finally {
    cleanup();
  }
});

test('helper: non-boolean spare values and a non-string sessionId are not a spare', () => {
  try {
    for (const spare of ['true', 1, {}, [], null, false]) {
      const cfg = claudeDir({ '1.json': spareFile(SPARE, { spare }) });
      assert.equal(isSpareSession(SPARE, helperOpts(cfg)), false, `spare ${JSON.stringify(spare)}`);
    }
    const cfg = claudeDir({ '1.json': { sessionId: 42, spare: true } });
    assert.equal(isSpareSession('42', helperOpts(cfg)), false, 'sessionId is compared with ===');
  } finally {
    cleanup();
  }
});

test('helper: a missing directory, a file in its place, and unreadable entries never throw and are not a spare', () => {
  try {
    assert.equal(isSpareSession(SPARE, { env: { CLAUDE_CONFIG_DIR: join(tmp('sterling-h1-spare-none-'), 'absent') }, home: '/nonexistent-home' }), false);
    const asFile = tmp('sterling-h1-spare-cfg-');
    writeFileSync(join(asFile, 'sessions'), 'not a directory');
    assert.equal(isSpareSession(SPARE, helperOpts(asFile)), false);
    const cfg = claudeDir({});
    mkdirSync(join(cfg, 'sessions', '9.json')); // a directory with a .json name
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), false);
    writeFileSync(join(cfg, 'sessions', '10.json'), JSON.stringify(spareFile(SPARE)));
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), true, 'the bad entry does not hide a valid one');
  } finally {
    cleanup();
  }
});

test('helper: only .json names are read, so a .key file carrying the marker is ignored', () => {
  try {
    const body = JSON.stringify(spareFile(SPARE));
    const cfg = claudeDir({ '2824593.0a1b2c.key': body, '2824593.json.bak': body, 'json': body });
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), false);
  } finally {
    cleanup();
  }
});

test('helper: an oversize sessions file is skipped, not read', () => {
  try {
    const cfg = claudeDir({ '1.json': JSON.stringify({ ...spareFile(SPARE), pad: 'x'.repeat(70_000) }) });
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), false);
  } finally {
    cleanup();
  }
});

test(`helper: at most ${SESSION_FILE_CAP} .json files are read, in name order; a marker past the cap is not a spare`, () => {
  try {
    assert.equal(SESSION_FILE_CAP, 256);
    const name = (i) => `${String(i).padStart(6, '0')}.json`;
    const sessions = {};
    for (let i = 0; i < SESSION_FILE_CAP; i += 1) sessions[name(i)] = realFile(`real-${i}`);
    sessions[name(SESSION_FILE_CAP)] = spareFile(SPARE);
    for (let i = 0; i < 40; i += 1) sessions[`${String(i).padStart(6, '0')}.abc.key`] = 'key';
    const cfg = claudeDir(sessions);
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), false, 'the 257th .json file is past the cap');
    rmSync(join(cfg, 'sessions', name(0)));
    assert.equal(isSpareSession(SPARE, helperOpts(cfg)), true, 'with one fewer file it is inside the cap; .key files do not count toward it');
    assert.equal(isSpareSession(SPARE, { ...helperOpts(cfg), cap: 3 }), false, 'the cap is honoured when passed');
  } finally {
    cleanup();
  }
});
