// OpenCode context parity with H1 and H19 (board cbee2b3d, audit f2ba68c2 rows 2 and 24).
// The host-neutral H1 operating-state lines (MACHINE ROLE, Project mode, TDD posture,
// the undeclared-source scan) reach the OpenCode conductor's context, and a child
// (subagent) session gets H19's dispatch staging from its own brief. Staging follows
// decision h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar: a child
// session's brief is its own first user message, so attribution is exact by
// construction; a child whose brief cannot be read is told so, never guessed for.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';

let SterlingStore;
let lib;
let contextMod;
let stageLib;
let maintLib;
before(async () => {
  maintLib = await import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'maintenance-state.mjs')).href);
  stageLib = await import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'stage-brief.mjs')).href);
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  lib = await import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'operating-state.mjs')).href);
  contextMod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'context.mjs')).href);
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const envelope = (type) => ({ id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] });

function addArticle(store, slug, path, content) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title: `${slug} title`,
    what_it_does: `${slug} does the thing`,
    intended_behavior: 'x',
    files: [{ path, role: 'impl' }],
    file_baselines: { [path]: sha(content) },
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
}

function addHazard(store, slug, path) {
  return store.create({
    ...envelope('anti_pattern'),
    slug,
    title: `Hazard ${slug}`,
    trigger: 'Editing the thing without care',
    right_way: 'Edit the thing with care',
    wrong_way: 'Edit the thing in a hurry',
    guidance: 'Edit the thing with care',
    source_evidence: 'fixture',
    severity: 'warn',
    file_keys: [path],
  });
}

function makeProject(config = { project_name: 'fixture-proj' }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-opstate-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  addArticle(store, 'a-article', 'src/a.mjs', 'export const a = 1;\n');
  addHazard(store, 'a-hazard', 'src/a.mjs');
  store.close();
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  }
  return dir;
}

/** Builds a createContextHandler whose collaborators are stubbed, except the ones under test. stale-claim-ok */
function handler(dir, { sessions = {}, pluginRoot, getSession } = {}) {
  const session = {
    get: async ({ sessionID }) => {
      const s = sessions[sessionID];
      if (s instanceof Error) throw s;
      if (!s) throw new Error(`no session ${sessionID}`);
      return { id: sessionID, ...s };
    },
  };
  return contextMod.createContextHandler({
    openStore: (p) => new SterlingStore(p),
    now: () => NOW,
    rootOf: () => dir,
    fenced: async (_name, _root, fn) => fn(),
    rotationRestore: async () => '',
    sessionSync: async () => {},
    pluginRoot: pluginRoot ?? join(dir, 'no-such-plugin-root'),
    getSession: getSession ?? (() => session),
  });
}

const textOf = (i) => i.system.map((p) => p.text).join('\n');
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const input = (sessionID, messages = []) => ({ sessionID, agent: 'build', system: [{ type: 'text', text: 'base' }], messages, tools: {} });

// ---- the shared lines (scripts/hooks/lib/operating-state.mjs) --------------

test('shared lib: project-mode line has the three H1 states', () => {
  assert.match(lib.projectModeLine({ config: {}, configUnreadable: false }), /^Project mode: HOBBY \(config\.mode/);
  assert.match(lib.projectModeLine({ config: { mode: 'work' }, configUnreadable: false }), /^Project mode: WORK/);
  assert.match(lib.projectModeLine({ config: { mode: 'bogus' }, configUnreadable: false }), /^Project mode: INVALID \('bogus'\)/);
  assert.match(lib.projectModeLine({ config: null, configUnreadable: true }), /^Project mode: UNKNOWN/);
});

test('shared lib: TDD posture reads ON by default, OFF only on an explicit false, UNKNOWN when unreadable', () => {
  assert.match(lib.tddPostureLine({ config: {}, configUnreadable: false }), /^TDD posture: tests-first ON/);
  assert.match(lib.tddPostureLine({ config: { tdd: { enabled: false } }, configUnreadable: false }), /^TDD posture: tests-first OFF/);
  assert.match(lib.tddPostureLine({ config: null, configUnreadable: true }), /^TDD posture: UNKNOWN/);
});

test('shared lib: machine role is stated only at a Sterling clone, or for an installed copy', () => {
  assert.equal(lib.machineRoleLine({ atClone: false, installedCopy: false, config: { machine_role: 'authoring' } }), '');
  assert.match(lib.machineRoleLine({ atClone: true, installedCopy: false, config: { machine_role: 'authoring' } }), /^MACHINE ROLE: AUTHORING/);
  assert.match(lib.machineRoleLine({ atClone: true, installedCopy: false, config: { machine_role: 'consumer' } }), /^MACHINE ROLE: CONSUMER/);
  assert.match(lib.machineRoleLine({ atClone: true, installedCopy: false, config: null }), /^MACHINE ROLE: UNDECLARED/);
  assert.match(lib.machineRoleLine({ atClone: false, installedCopy: true, config: null }), /^MACHINE ROLE: INSTALLED PLUGIN/);
});

test('shared lib: readProjectConfig separates absent, unreadable and non-object configs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-cfg-'));
  try {
    assert.deepEqual(lib.readProjectConfig(dir), { config: null, configUnreadable: false }, 'absent file is the documented default');
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ nope');
    assert.equal(lib.readProjectConfig(dir).configUnreadable, true, 'malformed JSON');
    writeFileSync(join(dir, '.sterling', 'config.json'), '[]');
    assert.equal(lib.readProjectConfig(dir).configUnreadable, true, 'parses but is not an object');
    writeFileSync(join(dir, '.sterling', 'config.json'), '{"mode":"work"}');
    assert.deepEqual(lib.readProjectConfig(dir), { config: { mode: 'work' }, configUnreadable: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the conductor's context (root session) --------------------------------

test('the root session context carries project mode and TDD posture, read live from config.json', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', mode: 'work', tdd: { enabled: false } });
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /Project mode: WORK/);
    assert.match(textOf(i), /TDD posture: tests-first OFF/);
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', tdd: { enabled: true } }));
    const j = input('ses_root');
    await h.onContext(j);
    assert.match(textOf(j), /Project mode: HOBBY/);
    assert.match(textOf(j), /TDD posture: tests-first ON/, 'a toggle flipped mid-session shows on the next request');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable config reads UNKNOWN on both lines, never the default', async () => {
  const dir = makeProject('{ not json');
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /Project mode: UNKNOWN/);
    assert.match(textOf(i), /TDD posture: UNKNOWN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MACHINE ROLE appears when the project is the Sterling clone itself, and never in another project', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', machine_role: 'authoring' });
  const other = mkdtempSync(join(tmpdir(), 'sterling-oc-other-root-'));
  try {
    const atClone = handler(dir, { pluginRoot: dir, sessions: { ses_root: {} } });
    const i = input('ses_root');
    await atClone.onContext(i);
    assert.match(textOf(i), /MACHINE ROLE: AUTHORING/);
    const elsewhere = handler(dir, { pluginRoot: other, sessions: { ses_root: {} } });
    const j = input('ses_root');
    await elsewhere.onContext(j);
    assert.doesNotMatch(textOf(j), /MACHINE ROLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('the undeclared-source scan discloses a tracked source file no toolchain covers, once per process', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', toolchains: [{ adapter: 'node', path_globs: ['lib/**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] });
  try {
    const h = handler(dir, { sessions: { ses_root: {}, ses_other: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /UNDECLARED SOURCE/i, 'src/a.mjs is source outside every declared glob');
    assert.match(textOf(i), /- src: 1 uncovered source-extension file\(s\)/, 'the report names the uncovered directory');
    const again = input('ses_root');
    await h.onContext(again);
    assert.match(textOf(again), /UNDECLARED SOURCE/i, 'the same session keeps seeing it on later requests (cached, not rescanned)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed config renders the undeclared-source check as UNAVAILABLE, never silence', async () => {
  const dir = makeProject('{ not json');
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /UNDECLARED SOURCE CHECK UNAVAILABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- child-session dispatch staging (H19) ---------------------------------

test('a child session gets the territory records for the paths its own brief names', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_child: { parentID: 'ses_root' } } });
    const i = input('ses_child', [userMsg('Fix the bug in src/a.mjs and report back.')]);
    await h.onContext(i);
    const text = textOf(i);
    assert.match(text, /STERLING KNOWLEDGE DELIVERY/i, 'a payload header names the staged territory');
    assert.match(text, /a-article/, 'the owning article');
    assert.match(text, /Hazard a-hazard/, 'the governing hazard');
    assert.match(text, /src\/a\.mjs/);
    // The system prompt is rebuilt per request, so the staged text rides every request of the child (as the rotation restore does).
    const again = input('ses_child', [userMsg('Fix the bug in src/a.mjs and report back.')]);
    await h.onContext(again);
    assert.match(textOf(again), /a-article does the thing/, 'the child keeps its staged records on later requests');
    assert.match(textOf(again), /Hazard a-hazard/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a root session is never staged from its messages', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root', [userMsg('Look at src/a.mjs please.')]);
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /a-article/);
    assert.doesNotMatch(textOf(i), /DISPATCH STAGING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a child whose brief cannot be read is told its knowledge was not staged', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_child: { parentID: 'ses_root' } } });
    const i = input('ses_child', []);
    await h.onContext(i);
    assert.match(textOf(i), /DISPATCH STAGING \(H19\).*YOUR KNOWLEDGE WAS NOT STAGED/s);
    assert.doesNotMatch(textOf(i), /a-article/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a child brief that names no governed path stages nothing and says nothing', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_child: { parentID: 'ses_root' } } });
    const i = input('ses_child', [userMsg('Summarize what you know about nothing in particular.')]);
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /a-article/);
    assert.doesNotMatch(textOf(i), /NOT STAGED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when the session lookup fails the child is not guessed at: no staging, the failure is logged', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_child: new Error('lookup boom') } });
    const i = input('ses_child', [userMsg('Fix src/a.mjs')]);
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /a-article/);
    assert.match(textOf(i), /YOUR KNOWLEDGE WAS NOT STAGED/);
    assert.match(textOf(i), /\[session-lookup-failed\]/);
    assert.match(readFileSync(join(dir, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /session lookup failed: lookup boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the shared staging lib (scripts/hooks/lib/stage-brief.mjs) ------------

test('stage-brief lib: composeContext orders plan, payload, TDD, disclosure, return contract and exempts statusline-setup', () => {
  const full = stageLib.composeContext({ agentType: 'implementor', activePlanLine: 'PLAN', payload: 'PAYLOAD', tddPostureLine: 'TDD', unattributableLine: 'NOTSTAGED' });
  assert.deepEqual(full.split('\n\n').slice(0, 4), ['PLAN', 'PAYLOAD', 'TDD', 'NOTSTAGED']);
  assert.ok(full.endsWith(stageLib.RETURN_CONTRACT));
  assert.equal(stageLib.composeContext({ agentType: 'statusline-setup', payload: '' }), '');
  assert.equal(stageLib.composeContext({ agentType: 'researcher', payload: '' }), stageLib.RETURN_CONTRACT);
});

test('stage-brief lib: dispatchChrome gives the TDD posture line to implementors only, from the live config', () => {
  const dir = makeProject({ project_name: 'fixture-proj', tdd: { enabled: false } });
  try {
    assert.match(stageLib.dispatchChrome(dir, 'implementor').tddPostureLine, /tests-first OFF/);
    assert.equal(stageLib.dispatchChrome(dir, 'researcher').tddPostureLine, '');
    assert.equal(stageLib.dispatchChrome(dir, 'implementor').activePlanLine, '', 'no plan lock, no plan line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stage-brief lib: stageBrief returns null when nothing governs the brief, a payload plus record() otherwise', () => {
  const dir = makeProject();
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    try {
      const args = { store, cwd: dir, prompts: ['Fix src/a.mjs'], guardId: { agentId: 'ag1', sessionId: 's1' }, hazardMode: 'whole', leadingChrome: ['PLAN-LINE'], trailingChrome: ['TRAILER'] };
      assert.equal(stageLib.stageBrief({ ...args, prompts: ['nothing to see here'] }), null);
      const built = stageLib.stageBrief(args);
      assert.match(built.text, /^PLAN-LINE\n\nSTERLING KNOWLEDGE DELIVERY \(H19\)/);
      assert.match(built.text, /a-article/);
      assert.ok(built.text.endsWith('TRAILER'));
      assert.notEqual(stageLib.stageBrief(args), null, 'not delivered until record() runs');
      built.record();
      assert.equal(stageLib.stageBrief(args), null, 'after record() every record is already delivered');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- child chrome: plan line, TDD posture, return contract -----------------

test('a child session carries the return contract, and an implementor child the TDD posture, even when nothing is staged', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', tdd: { enabled: false } });
  try {
    const h = handler(dir, { sessions: { ses_child: { parentID: 'ses_root' } } });
    const i = input('ses_child', [userMsg('Summarize nothing in particular.')]);
    i.agent = 'sterling/implementor';
    await h.onContext(i);
    assert.match(textOf(i), /STERLING DEFAULT RETURN CONTRACT/);
    assert.match(textOf(i), /TDD posture: tests-first OFF/);
    assert.equal((textOf(i).match(/TDD posture:/g) ?? []).length, 2, 'the sterling/implementor child gets its own TDD line beside the conductor-level one');
    const r = input('ses_child', [userMsg('Summarize nothing in particular.')]);
    r.agent = 'sterling/researcher';
    const h2 = handler(dir, { sessions: { ses_child: { parentID: 'ses_root' } } });
    await h2.onContext(r);
    assert.match(textOf(r), /STERLING DEFAULT RETURN CONTRACT/);
    assert.equal((textOf(r).match(/TDD posture:/g) ?? []).length, 1, 'only the conductor-level line; the researcher child gets no second one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a root session never gets the return contract', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /STERLING DEFAULT RETURN CONTRACT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- queue depth and reconcile backlog ------------------------------------

const sysItem = (store, reason, createdAt = NOW) =>
  store.create({
    id: randomUUID(), type: 'todo', created_at: createdAt, updated_at: createdAt, author: 'system', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], text: `item ${reason}`, source: 'system', system_reason: reason, file_keys: ['src/a.mjs'],
  });

test('shared lib: queueDepthLine is silent below the threshold, then names the lanes, then the biggest lane', () => {
  const lib2 = maintLib;
  const state = (n, parked = 0) => ({ drainable: n, parked, queueReasonEntries: [['capture_owed', n]], queueReasons: [`${n} items in lane capture_owed`] });
  assert.equal(lib2.queueDepthLine({ ...state(14), deepThreshold: 15 }), '');
  assert.match(lib2.queueDepthLine({ ...state(15, 2), deepThreshold: 15 }), /^MAINTENANCE QUEUE IS DEEP — 15 drainable items \(15 items in lane capture_owed\) plus 2 file_parked/);
  assert.match(lib2.queueDepthLine({ ...state(150), deepThreshold: 15 }), /^MAINTENANCE QUEUE IS VERY DEEP — 150 drainable items across 1 lane\(s\)/);
  assert.match(lib2.queueDepthLine({ ...state(1), deepThreshold: 0 }), /^MAINTENANCE QUEUE IS (VERY )?DEEP/, 'a threshold below 1 is clamped to 1');
});

test('the root session context states a deep maintenance queue and the reconcile backlog', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', maintenance_queue: { deep_threshold: 2 } });
  // The npm test preload sets STERLING_MAINTENANCE_WORKER_DISABLE and the context reads process.env; the worker line is asserted against a default launcher state.
  const workerDisable = process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
  delete process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    sysItem(store, 'reconcile_needed', '2026-09-29T12:00:00.000Z');
    sysItem(store, 'capture_owed');
    sysItem(store, 'capture_owed');
    sysItem(store, 'file_parked');
    store.close();
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    // Counts changed with board 27c87783: the depth counts the conductor's lanes only
    // (capture_owed 2 here), reconcile_needed being the background worker's.
    assert.match(textOf(i), /MAINTENANCE QUEUE IS DEEP — 2 drainable items/);
    assert.match(textOf(i), /plus 1 file_parked/);
    assert.match(textOf(i), /1 item in lane reconcile_needed is drained by the background worker/);
    assert.match(textOf(i), /RECONCILE BACKLOG: 1 item in lane reconcile_needed, the oldest open since 2026-09-29T12:00:00\.000Z/);
    // "worker not running" is replaced by the worker's state: 1 unjudged item, waited long past 30 minutes.
    assert.match(textOf(i), /worker due to launch at the next Stop or git commit \(1 unjudged, oldest /);
  } finally {
    if (workerDisable !== undefined) process.env.STERLING_MAINTENANCE_WORKER_DISABLE = workerDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shallow queue with no reconcile items adds no queue or backlog line', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, { sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /MAINTENANCE QUEUE|RECONCILE BACKLOG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- review-fix round: fail-closed lookups, root-only scan, bounded caches --

test('a session lookup that resolves to null, {} or another session is not read as root: no staging guess, a loud line', async () => {
  const dir = makeProject();
  try {
    for (const info of [null, {}, { id: 'ses_someone_else' }]) {
      const h = handler(dir, { getSession: () => ({ get: async () => info }) });
      const i = input('ses_child', [userMsg('Fix src/a.mjs')]);
      await h.onContext(i);
      assert.doesNotMatch(textOf(i), /a-article/, JSON.stringify(info));
      assert.match(textOf(i), /\[session-lookup-failed\]/, JSON.stringify(info));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the undeclared-source scan runs for root sessions only, once per process (not per session)', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', toolchains: [{ adapter: 'node', path_globs: ['lib/**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] });
  try {
    const h = handler(dir, { sessions: { ses_root: {}, ses_other: {}, ses_child: { parentID: 'ses_root' } } });
    const child = input('ses_child', [userMsg('Summarize nothing in particular.')]);
    await h.onContext(child);
    assert.doesNotMatch(textOf(child), /UNDECLARED SOURCE/i, 'a child session never gets the scan');
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /UNDECLARED SOURCE/i);
    // Cover src/ now: a per-session scan would see it; the per-process cache still holds the first answer.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] }));
    const other = input('ses_other');
    await h.onContext(other);
    assert.match(textOf(other), /UNDECLARED SOURCE/i, 'a second root session in the same process reuses the cached scan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the per-session caches are bounded: the oldest entry goes first', async () => {
  const { remember } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'bounded.mjs')).href);
  const m = new Map();
  for (let n = 0; n < 5; n++) remember(m, `k${n}`, n, 3);
  assert.deepEqual([...m.keys()], ['k2', 'k3', 'k4']);
  remember(m, 'k2', 'again', 3);
  assert.deepEqual([...m.keys()], ['k3', 'k4', 'k2'], 'a rewrite refreshes the entry');
});

test('MACHINE ROLE on OpenCode names the Sterling layer, not CLAUDE.md; the Claude text is unchanged', async () => {
  const dir = makeProject({ project_name: 'fixture-proj', machine_role: 'consumer' });
  try {
    const h = handler(dir, { pluginRoot: dir, sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    const roleLine = textOf(i).split('\n').find((l) => l.startsWith('MACHINE ROLE:'));
    assert.match(roleLine, /^MACHINE ROLE: CONSUMER — .*The Sterling layer's "this machine authors" language/);
    assert.doesNotMatch(roleLine, /CLAUDE\.md/);
    assert.match(lib.machineRoleLine({ atClone: true, installedCopy: false, config: { machine_role: 'consumer' } }), /The Sterling layer in CLAUDE\.md's "this machine authors"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable maintenance queue is a degraded line in the context, not only a log line', async () => {
  const dir = makeProject();
  try {
    const session = { get: async ({ sessionID }) => ({ id: sessionID }) };
    const h = contextMod.createContextHandler({
      openStore: () => {
        throw new Error('store locked');
      },
      now: () => NOW,
      rootOf: () => dir,
      fenced: async (_name, _root, fn) => fn(),
      rotationRestore: async () => '',
      sessionSync: async () => {},
      pluginRoot: join(dir, 'no-such-plugin-root'),
      getSession: () => session,
    });
    const i = input('ses_root');
    await h.onContext(i);
    assert.match(textOf(i), /MAINTENANCE QUEUE UNREADABLE \(store locked\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the root session context states the pending Sterling issue reports, with the flush command under the plugin root', async () => {
  const dir = makeProject();
  const pluginDir = mkdtempSync(join(tmpdir(), 'sterling-oc-plugin-root-'));
  try {
    const h = handler(dir, { pluginRoot: pluginDir, sessions: { ses_root: {} } });
    const i = input('ses_root');
    await h.onContext(i);
    assert.doesNotMatch(textOf(i), /Sterling issue reports:/, 'nothing queued, no line');
    const entry = JSON.stringify({ fingerprint: 'sterling-fp-000000000001', title: 't', body: 'b', labels: ['sterling-report'] });
    writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), `${entry}\n${entry}\n`);
    const j = input('ses_root');
    await h.onContext(j);
    assert.match(textOf(j), /Sterling issue reports: 2 queued in \.sterling\/pending-issue-reports\.jsonl, not yet filed on GitHub\./);
    assert.ok(textOf(j).includes(`node "${join(pluginDir, 'bin', 'report-issue.mjs')}" --flush`), 'the command names the resolved Sterling root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});
