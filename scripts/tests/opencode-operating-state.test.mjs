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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';

let SterlingStore;
let lib;
let contextMod;
before(async () => {
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

/** createContextHandler with every collaborator stubbed except the ones under test. */
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

test('the undeclared-source scan discloses a tracked source file no toolchain covers, once per session', async () => {
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
    const again = input('ses_child', [userMsg('Fix the bug in src/a.mjs and report back.')]);
    await h.onContext(again);
    assert.doesNotMatch(textOf(again), /a-article does the thing/, 'delivered records are not resent on the child\'s next request');
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
