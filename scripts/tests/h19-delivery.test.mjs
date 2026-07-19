// H19 knowledge delivery (decision fe62546f, brief retrieval-first-knowledge-
// delivery): file-touch delivery + frontier signal + session guard + drain.
// AC7 pins the floor everywhere: no path through these hooks may exit 2.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-07-19T12:00:00.000Z';

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
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
    stack_tags: [],
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function makeProject({ rung = 'prompt', withRun = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  if (withRun) {
    const brief = store.create({
      ...envelope('brief'),
      slug: 'f',
      title: 'F',
      problem: 'p',
      feature: 'f',
      user_stated: { criteria: [], constraints: [] },
      conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [],
      out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({
      id: 'r-h19',
      brief_ref: brief.id,
      branch: 'sterling/run-r-h19',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
    });
  }
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});
const preEdit = (dir, file, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

test('rung prompt: owned Read enqueues payload; drain injects once and empties the queue', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1);
    assert.match(pending[0].payload, /STERLING KNOWLEDGE DELIVERY/);
    assert.match(pending[0].payload, /alpha does the alpha thing/);
    assert.match(pending[0].payload, /AC1: alpha works/);

    const drain = runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
    assert.equal(drain.code, 0);
    const out = JSON.parse(drain.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /alpha does the alpha thing/);
    assert.equal(pendingOf(dir).length, 0);

    const drain2 = runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
    assert.equal(drain2.code, 0);
    assert.equal(drain2.stdout, '');
  } finally {
    cleanup();
  }
});

test('guard: same file and same-article new file stay silent; a NEW owning article re-arms', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs', 'src/a2.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir); // same file
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a2.mjs'), dir); // same article
    assert.equal(pendingOf(dir).length, 1);
    store.create(article('beta', ['src/b.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir); // scope growth
    const pending = pendingOf(dir);
    assert.equal(pending.length, 2);
    assert.match(pending[1].payload, /beta does the beta thing/);
  } finally {
    cleanup();
  }
});

test('rung read: PostToolUse injects directly, nothing queued; PreToolUse stays silent', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const pre = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/a.mjs'), dir);
    assert.equal(pre.code, 0);
    assert.equal(pre.stdout, '');
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /alpha does the alpha thing/);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('rung edit: PreToolUse Edit injects; a Read touch falls back to the queue', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'edit' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    const pre = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/a.mjs'), dir);
    const out = JSON.parse(pre.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /alpha/);
    const read = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    assert.equal(read.stdout, '');
    assert.equal(pendingOf(dir).length, 1);
  } finally {
    cleanup();
  }
});

test('frontier signal: unowned territory notices once per file; owned territory never notices', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/new.mjs'), dir);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/new.mjs'), dir);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1);
    assert.match(pending[0].payload, /FRONTIER SIGNAL/);
    assert.match(pending[0].payload, /src\/new\.mjs/);
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.ok(!pendingOf(dir).some((e) => e.kind === 'frontier' && e.rel === 'src/a.mjs'));
  } finally {
    cleanup();
  }
});

test('reference_material owner: pointer delivered, no frontier signal', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create({
      ...envelope('reference_material'),
      title: 'Design notes',
      kind: 'doc',
      location: 'docs/notes.md',
      summary: 'notes about things',
      source_date: '2026-07-01',
      capture_date: '2026-07-01',
    });
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'docs/notes.md'), dir);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'delivery');
    assert.match(pending[0].payload, /reference 'Design notes'/);
  } finally {
    cleanup();
  }
});

test('one-hop pointers: relies_on sibling renders as slug + one-liner, never a full body', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs'], { dependencies: { relies_on: ['alpha'], relied_by: [] } }));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    const payload = pendingOf(dir)[0].payload;
    assert.match(payload, /relies_on \[\[alpha\]\]: alpha does the alpha thing/);
    assert.ok(!payload.includes('alpha intends')); // pointer, not the neighbor's body
  } finally {
    cleanup();
  }
});

test('pipeline (AC6): active run silences agents (prep staged their pack) but not the conductor', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'a123' }), dir);
    assert.equal(pendingOf(dir).length, 0);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1);
  } finally {
    cleanup();
  }
});

test('per-agent guards (rung read): a subagent gets its own injection even after the conductor was served', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /alpha/);
    const agent = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'a9' }), dir);
    assert.match(JSON.parse(agent.stdout).hookSpecificOutput.additionalContext, /alpha/, 'own guard, own delivery');
  } finally {
    cleanup();
  }
});

test('rung prompt: subagent touches never enqueue — the queue serves only the conductor prompt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'a9' }), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('self-healing: corrupt guard resets and delivers; corrupt queue is discarded loudly, never wedged', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const gPath = join(dir, '.sterling', 'transient', 'delivery', 'guard-conductor.json');
    mkdirSync(dirname(gPath), { recursive: true });
    writeFileSync(gPath, '{not json');
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, `corrupt guard must reset, not fail: ${r.stderr}`);
    assert.equal(pendingOf(dir).length, 1, 'delivery proceeds after guard reset');

    const pPath = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
    writeFileSync(pPath, '[broken');
    const drain = runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
    assert.equal(drain.code, 0, `corrupt queue must discard, not wedge: ${drain.stderr}`);
    assert.match(drain.stderr, /corrupt pending-delivery queue/);
    assert.ok(!existsSync(pPath), 'corrupt queue file removed — next enqueue starts clean');
  } finally {
    cleanup();
  }
});

test('unknown injection_rung falls back to prompt (enqueue), never to a silently different mode', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'sideways' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const pre = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/a.mjs'), dir);
    assert.equal(pre.stdout, '', 'PreToolUse must not inject on a bogus rung');
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1, 'falls back to the queue');
  } finally {
    cleanup();
  }
});

test('never blocks (AC7): no store, outside-repo path, .sterling tree — always exit 0', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h19-bare-'));
  try {
    assert.equal(runHook('h19-knowledge-delivery.mjs', postRead(bare, 'src/a.mjs'), bare).code, 0);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/elsewhere/x.mjs' }, cwd: dir }, dir).code, 0);
    assert.equal(runHook('h19-knowledge-delivery.mjs', postRead(dir, '.sterling/config.json'), dir).code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('h19-clear-session: SessionStart removes guard and queue (whole-session TTL, P4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const deliveryDir = join(dir, '.sterling', 'transient', 'delivery');
    assert.ok(existsSync(deliveryDir));
    const r = runHook('h19-clear-session.mjs', { hook_event_name: 'SessionStart', cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(deliveryDir));
  } finally {
    cleanup();
  }
});
