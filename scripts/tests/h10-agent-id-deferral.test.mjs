// H10 AGENT-ID DEFERRAL — decision h22-dispatch-files-from-review-territory-
// and-resume-inherits-prior-round (e841facd), amendment 2026-10-02 (2):
// "Once a live subagent Write shows agent_id in the touches file, H10 defers a
// touch whose agent has a presumed-active register row." Why: files a lane
// creates outside its declared territory, and second-level subagents, are
// otherwise owned by nobody while the lane runs (finding
// h10-article-demand-misses-live-lanes-same-type-fanout-and-out-of-territory-
// files-october-2026, 79e20118).
//
// The probe that unblocked this (2026-10-03): a subagent Write produced a
// touches.json record {path, at, agent_id} whose agent_id matched a
// dispatch-register row's agent_id.
//
// Fixture geometry, sized against the defaults (article_demand.
// min_unowned_files 3, dispatch_register.stale_minutes 60): four unowned
// touched files, capture satisfied, so the article demand is the only duty
// that can fire. ALPHA and BETA are written by the subagent (their touches
// carry its agent_id); GAMMA and DELTA by the conductor (no agent_id). The
// register row's `files` names a path OUTSIDE all four, so a path join alone
// can never defer them. When the agent_id join defers ALPHA and BETA, two
// unowned files remain, under the threshold, and the Stop releases (0). When
// it does not, all four are demanded (2).
//
// Harness copied in shape from h10-deferral-article-demand-and-pending-
// carry.test.mjs (sibling test files duplicate helpers rather than importing
// each other, which would double-run their tests).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

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

const out = (r) => `${r.stdout}\n${r.stderr}`;
const noticesDir = (dir) => join(dir, '.sterling', 'transient', 'notices');
const disclosed = (r, dir) =>
  [out(r), ...(existsSync(noticesDir(dir)) ? readdirSync(noticesDir(dir)).map((n) => readFileSync(join(noticesDir(dir), n), 'utf8')) : [])].join('\n');

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-agentid-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  // Capture duty satisfied, so the article demand is the only duty that can fire.
  store.create({
    id: randomUUID(),
    type: 'decision',
    created_at: CAPTURE_AT,
    updated_at: CAPTURE_AT,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    title: 'learned things',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const stopOnce = (dir) =>
  runHook(
    'h10-direct-capture.mjs',
    { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' },
    dir
  );

const ALPHA = 'src/lane/alpha.mjs';
const BETA = 'src/lane/beta.mjs';
const GAMMA = 'src/main/gamma.mjs';
const DELTA = 'src/main/delta.mjs';
const LANE = 'ab760e67b73a55a29';

// touches: [{path, agent_id?}] — every path is created on disk, since H10
// acts only on files that still exist.
function writeTouches(dir, touches) {
  for (const { path } of touches) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), '// touched\n');
  }
  writeFileSync(
    join(dir, '.sterling', 'transient', 'touches.json'),
    JSON.stringify(touches.map(({ path, agent_id, at }) => (agent_id ? { path, at: at ?? NOW, agent_id } : { path, at: at ?? NOW })))
  );
}

const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');
const writeRegister = (dir, rows) => writeFileSync(registerPath(dir), JSON.stringify(rows));
const agoISO = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const row = (agentId, over = {}) => ({
  agent_id: agentId,
  agent_type: 'implementor',
  session_id: 's1',
  files: ['src/declared/elsewhere.mjs'], // outside every touched path
  at: agoISO(1),
  ...over,
});

const laneAndMainTouches = (agentId = LANE, laneAt) => [
  { path: ALPHA, agent_id: agentId, at: laneAt },
  { path: BETA, agent_id: agentId, at: laneAt },
  { path: GAMMA },
  { path: DELTA },
];

const demandSection = (r) => {
  const i = r.stderr.indexOf('article demand');
  assert.ok(i >= 0, `the article demand must be present verbatim; stderr: ${r.stderr}`);
  return r.stderr.slice(i);
};
const re = (p) => new RegExp(p.replace(/[.]/g, '\\.'));

test('(1) a touch carrying the agent_id of a presumed-active register row is deferred, although its path is outside that row\'s files', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches());
    const reg = [row(LANE)];
    writeRegister(dir, reg);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, `ALPHA and BETA belong to the live lane, so only 2 unowned files remain, under the threshold of 3; stderr: ${r.stderr}`);
    assert.doesNotMatch(out(r), /article demand/i, 'no demand for territory a live lane is still writing');
    const d = disclosed(r, dir);
    assert.match(d, /deferred: 2 file\(s\)/, 'the release discloses exactly the two agent-written paths as deferred');
    assert.match(d, new RegExp(LANE), 'the deferral names the writing agent as the owner');
    assert.match(d, re(ALPHA));
    assert.match(d, re(BETA));
    assert.deepEqual(JSON.parse(readFileSync(registerPath(dir), 'utf8')), reg, 'H10 never mutates the dispatch register');
  } finally {
    cleanup();
  }
});

test('(2) the same agent_id on an ENDED register row defers nothing — the lane has landed, its files are owed now', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches());
    writeRegister(dir, [row(LANE, { ended: { event: 'subagent-stop', at: agoISO(0) } })]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `all four files are unowned and undeferred, so the demand fires; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [ALPHA, BETA, GAMMA, DELTA]) assert.match(s, re(p), `${p} is demanded`);
  } finally {
    cleanup();
  }
});

test('(2b) the same agent_id on a row past the lease (status unknown, not presumed-active) defers nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches());
    writeRegister(dir, [row(LANE, { at: agoISO(120) })]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `an expired lease is not a licence to defer; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [ALPHA, BETA]) assert.match(s, re(p), `${p} is demanded`);
  } finally {
    cleanup();
  }
});

// Decision h10-lane-liveness-from-recent-touches-past-the-lease: the register's
// `at` is never refreshed, so a lane running past the lease is kept alive by its
// own recent H7 touches (stale_minutes defaults to 60). (2b) above is the
// control: its touches are months old, so the lane still ages out.
test('(2c) a row past the lease whose agent_id has a RECENT touch counts as running: its touches defer, with no unknown note', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches(LANE, agoISO(2)));
    const reg = [row(LANE, { at: agoISO(120) })];
    writeRegister(dir, reg);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, `ALPHA and BETA belong to a lane that is still writing; stderr: ${r.stderr}`);
    assert.doesNotMatch(out(r), /article demand/i);
    const d = disclosed(r, dir);
    assert.match(d, /deferred: 2 file\(s\)/);
    assert.match(d, new RegExp(LANE));
    assert.doesNotMatch(d, /dispatch_status_unknown/, 'a lane kept alive by its writes is not an unknown-status dispatch');
    assert.deepEqual(JSON.parse(readFileSync(registerPath(dir), 'utf8')), reg, 'H10 never mutates the dispatch register');
  } finally {
    cleanup();
  }
});

test('(2d) a row past the lease whose newest touch is itself older than the lease still ages out', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches(LANE, agoISO(90)));
    writeRegister(dir, [row(LANE, { at: agoISO(120) })]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `a lane that stopped writing loses its deferral; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [ALPHA, BETA]) assert.match(s, re(p), `${p} is demanded`);
  } finally {
    cleanup();
  }
});

test('(2e) a recent touch by ANOTHER agent_id does not keep this lane alive', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches('some-other-agent', agoISO(2)));
    writeRegister(dir, [row(LANE, { at: agoISO(120) })]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// The liveness evidence is read from the claimed touches BEFORE H10's git
// filter drops a tracked, unchanged path. A lane whose recent write (ALPHA) was
// committed has no touch left after the filter; its older uncommitted write
// (BETA) must still be deferred to it, because the lane is still running.
test('(2f) a lane whose RECENT write was committed (dropped by the git filter) is still running: its older uncommitted touch defers', () => {
  const { dir, cleanup } = makeProject();
  try {
    const git = (...args) => {
      const g = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`);
      return g.stdout.trim();
    };
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git('init', '-q');
    git('config', 'user.email', 'h10@sterling.test');
    git('config', 'user.name', 'H10 Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeTouches(dir, [{ path: ALPHA }]);
    git('add', '-A');
    git('commit', '-q', '-m', 'lane commits alpha');
    writeFileSync(
      join(dir, '.sterling', 'transient', 'git-settled.json'),
      JSON.stringify({ sha: git('rev-parse', 'HEAD'), dirty: {}, at: agoISO(30) })
    );
    writeTouches(dir, [
      { path: ALPHA, agent_id: LANE, at: agoISO(2) },
      { path: BETA, agent_id: LANE, at: agoISO(90) },
      { path: GAMMA },
      { path: DELTA },
    ]);
    writeRegister(dir, [row(LANE, { at: agoISO(120) })]);

    const r = stopOnce(dir);
    const d = disclosed(r, dir);
    assert.match(d, new RegExp(`deferred: 1 file\\(s\\) owned by live dispatch\\(es\\) \\[${LANE}\\]: ${BETA.replace(/[.]/g, '\\.')}`), `BETA is deferred to the lane that is still writing: ${d}`);
    const demanded = r.stderr.includes('article demand') ? demandSection(r) : '';
    assert.doesNotMatch(demanded, re(BETA), 'BETA is not demanded');
    assert.match(demanded, re(GAMMA), 'the conductor-written files are still demanded (the demand ran)');
    assert.doesNotMatch(d, /dispatch_status_unknown/, 'a lane kept alive by its committed writes is not an unknown-status dispatch');
  } finally {
    cleanup();
  }
});

test('(3) an agent_id with no register row defers nothing — the demand fires as before', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, laneAndMainTouches());
    writeRegister(dir, [row('some-other-live-lane')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `no live row carries this agent_id, so all four are demanded; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [ALPHA, BETA, GAMMA, DELTA]) assert.match(s, re(p), `${p} is demanded`);
    assert.doesNotMatch(out(r), new RegExp(LANE), 'an agent without a register row is never named as an owner');
  } finally {
    cleanup();
  }
});

test('(4) touches without agent_id keep the path join only: a live row whose files miss every path defers nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: ALPHA }, { path: BETA }, { path: GAMMA }, { path: DELTA }]);
    writeRegister(dir, [row(LANE)]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `no touch carries an agent_id and no row files match, so all four are demanded; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [ALPHA, BETA, GAMMA, DELTA]) assert.match(s, re(p), `${p} is demanded`);
  } finally {
    cleanup();
  }
});

test('(4b) touches without agent_id still defer through the row\'s files, as before', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: ALPHA }, { path: BETA }, { path: GAMMA }, { path: DELTA }]);
    writeRegister(dir, [row(LANE, { files: [ALPHA, BETA] })]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, `the row's files own ALPHA and BETA, leaving 2 unowned; stderr: ${r.stderr}`);
    assert.match(disclosed(r, dir), /deferred: 2 file\(s\)/);
  } finally {
    cleanup();
  }
});

// Fan-out of the same agent type, both lanes writing outside what they declared
// (finding h10-article-demand-misses-live-lanes-same-type-fanout-and-out-of-
// territory-files-october-2026, 79e20118; board item 7e4850cf, REMAINING (1)).
// Two live implementor rows each declare one path that no touch matches. LANE
// writes ALPHA and BETA; LANE_B writes GAMMA; three conductor-written files
// (DELTA and two more) meet the threshold, so the article demand runs and is
// shown not to ask for the lanes' files. Every deferral here comes from the
// agent_id join, since no register row's files covers a touched path. Three
// deferred paths, because a blocking Stop's `deferred:` line names at most 3
// paths and then "+K more" (deferralLine(cap), by design).
test('(5) two live same-type lanes writing outside their declared files: their paths are not demanded, and the deferred line names both lanes and every written path', () => {
  const { dir, cleanup } = makeProject();
  try {
    const LANE_B = 'b3c1d9e47f20a6581';
    const EPSILON = 'src/main/epsilon.mjs';
    const EPSILON_2 = 'src/main/epsilon-two.mjs';
    writeTouches(dir, [
      { path: ALPHA, agent_id: LANE },
      { path: BETA, agent_id: LANE },
      { path: GAMMA, agent_id: LANE_B },
      { path: DELTA },
      { path: EPSILON },
      { path: EPSILON_2 },
    ]);
    const reg = [
      row(LANE, { files: ['src/declared/lane-one.mjs'] }),
      row(LANE_B, { files: ['src/declared/lane-two.mjs'] }),
    ];
    writeRegister(dir, reg);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, `the three conductor-written files meet the threshold, so the demand fires; stderr: ${r.stderr}`);
    const s = demandSection(r);
    for (const p of [DELTA, EPSILON, EPSILON_2]) assert.match(s, re(p), `${p} is demanded`);
    for (const p of [ALPHA, BETA, GAMMA]) assert.doesNotMatch(s, re(p), `${p} is written by a live lane and is not demanded`);

    const deferredLine = disclosed(r, dir).split('\n').find((l) => l.includes('deferred:'));
    assert.ok(deferredLine, `a deferred: line must be disclosed; output: ${out(r)}`);
    assert.match(deferredLine, /deferred: 3 file\(s\)/, 'all three lane-written paths are deferred');
    assert.match(deferredLine, new RegExp(LANE), 'the first lane is named');
    assert.match(deferredLine, new RegExp(LANE_B), 'the second lane is named');
    for (const p of [ALPHA, BETA, GAMMA]) assert.match(deferredLine, re(p), `${p} is named in the deferred line`);
    for (const p of [DELTA, EPSILON, EPSILON_2]) assert.doesNotMatch(deferredLine, re(p), `${p} is the conductor's and is not deferred`);
    assert.deepEqual(JSON.parse(readFileSync(registerPath(dir), 'utf8')), reg, 'H10 never mutates the dispatch register');
  } finally {
    cleanup();
  }
});
