// H19 knowledge delivery (decision 6dfbe675, brief retrieval-first-knowledge-
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

// Ordering contract (council wf_db9a59aa-0af): the guard is what makes delivery
// once-per-session, so it must be written only AFTER the delivery side effect
// actually completed. Written first, any failure becomes permanent silent loss —
// the next touch sees the article already marked and the `fresh.length === 0`
// short-circuit turns it into a session-long no-op with no residue.
// Failure is injected by making pending.json a DIRECTORY: enqueuePending reads
// before it writes, so readFileSync throws EISDIR.
test('ordering: a delivery that FAILS leaves the guard unwritten, so the next touch retries instead of losing the article', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const dDir = join(dir, '.sterling', 'transient', 'delivery');
    mkdirSync(join(dDir, 'pending.json'), { recursive: true });

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    // AC7 is "never DENIES a tool call" — exit 2 is the only blocking code. A
    // delivery failure exits 1: loud on stderr (P5) but non-blocking.
    assert.notEqual(r.code, 2, 'a delivery failure must never DENY the tool call (AC7)');
    assert.match(r.stderr, /H19/, 'the failure is loud, not swallowed (P5)');
    const gPath = join(dDir, 'guard-conductor.json');
    const guard = existsSync(gPath) ? JSON.parse(readFileSync(gPath, 'utf8')) : { records: [], frontier_files: [] };
    assert.deepEqual(guard.records, [], 'guard must NOT record a delivery that did not happen');

    rmSync(join(dDir, 'pending.json'), { recursive: true, force: true });
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1, 'the retry delivers — the article was never silently written off');
  } finally {
    cleanup();
  }
});

test('ordering (frontier): a failed unowned-territory notice leaves the file unmarked, so it retries', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // no owning article for src/orphan.mjs — the frontier path
    const dDir = join(dir, '.sterling', 'transient', 'delivery');
    mkdirSync(join(dDir, 'pending.json'), { recursive: true });

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.notEqual(r.code, 2, 'a frontier-notice failure must never DENY the tool call (AC7)');
    const gPath = join(dDir, 'guard-conductor.json');
    const guard = existsSync(gPath) ? JSON.parse(readFileSync(gPath, 'utf8')) : { records: [], frontier_files: [] };
    assert.deepEqual(guard.frontier_files, [], 'frontier file must NOT be marked when its notice failed to deliver');

    rmSync(join(dDir, 'pending.json'), { recursive: true, force: true });
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'frontier');
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

// ---------------------------------------------------------------------------
// Hazards and rationale for the touched path (decision ca23c811). Delivery had
// been articles-only, so an anti_pattern naming the EXACT file being edited was
// never delivered while H10 asked at Stop whether a hazard had been RECORDED.
// ---------------------------------------------------------------------------

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

function decisionRecord(statement, paths, extra = {}) {
  return {
    ...envelope('decision'),
    title: statement,
    statement,
    alternatives_rejected: [],
    rationale: `${statement} rationale`,
    file_keys: paths,
    ...extra,
  };
}

test('H19: an anti_pattern owning the touched path delivers as SUBSTANCE (trigger + right_way), leading the payload', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('one-way latch', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'one-way latch'/, 'the hazard is named, with its severity');
    assert.match(ctx, /TRIGGER: one-way latch trigger text/, 'trigger renders as substance, not a pointer');
    assert.match(ctx, /RIGHT WAY: one-way latch right way text/, 'right_way renders as substance');
    assert.ok(
      ctx.indexOf('ANTI-PATTERN') < ctx.indexOf("article 'alpha'"),
      'hazards LEAD: "do not do this here" outranks what the territory is'
    );
  } finally {
    cleanup();
  }
});

test('H19: a hazard in UNOWNED territory delivers WITH the frontier signal — the case the early return used to swallow', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    // No article owns this path: only the hazard does. Before ca23c811 the
    // frontier branch returned early and the hazard was never seen.
    store.create(antiPattern('latch', ['src/orphan.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING FRONTIER SIGNAL/, 'territory is still UNOWNED — a hazard is not ownership');
    assert.match(ctx, /H10 will demand the owning article/, "H10's demand surface is unchanged");
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'latch'/, 'and the hazard arrives anyway');
    // The notice must not tell the reader there is nothing here while a hazard
    // prints underneath it — a reader who believes that sentence stops reading.
    assert.doesNotMatch(ctx, /There is no knowledge to deliver/, 'the frontier header cannot claim emptiness above a hazard');
    assert.match(ctx, /KEEP READING/, 'it points the reader at what the store DOES hold for this path');
  } finally {
    cleanup();
  }
});

test('H19: the pure-frontier notice (no hazards, no decisions) is unchanged — it still says there is nothing to deliver', () => {
  const { dir, cleanup } = makeProject({ rung: 'read' });
  try {
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/nothing.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /There is no knowledge to deliver/, 'unowned AND empty is still stated plainly');
    assert.doesNotMatch(ctx, /KEEP READING/);
  } finally {
    cleanup();
  }
});

test('H19: hazards render most-severe-first; absent severity reads as warn', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('info one', ['src/a.mjs'], { severity: 'info' }));
    store.create(antiPattern('no severity', ['src/a.mjs']));
    store.create(antiPattern('blocker', ['src/a.mjs'], { severity: 'block' }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.indexOf("'blocker'") < ctx.indexOf("'no severity'"), 'block outranks the warn default');
    assert.ok(ctx.indexOf("'no severity'") < ctx.indexOf("'info one'"), 'the warn default outranks info');
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'no severity'/, 'absent severity renders as WARN');
  } finally {
    cleanup();
  }
});

test('H19: decisions render as CAPPED POINTERS, never bodies, and the overflow is stated with the widening query', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    for (let i = 0; i < 11; i += 1) store.create(decisionRecord(`choice ${i}`, ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /DECISIONS for this path \(11\)/, 'the true total is stated, not the shown count');
    assert.equal(ctx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 8, 'exactly the cap renders as pointers');
    assert.doesNotMatch(ctx, /choice \d+ rationale/, 'pointers carry the statement only — never the decision body');
    assert.match(ctx, /3 more NOT shown \(cap 8\)/, 'the drop is disclosed — a silent cap reads as "that is all there is"');
    assert.match(ctx, /knowledge_query types:\["decision"\] file_keys:\["src\/a\.mjs"\] cap:11/, 'and names the query that widens it');
  } finally {
    cleanup();
  }
});

test('H19: a decision pointer carries its rejected OPTIONS beneath the statement (decision 6a3b1a46)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(
      decisionRecord('breach timing is never shown to the player', ['src/a.mjs'], {
        alternatives_rejected: [
          { option: 'a numeric countdown in the HUD', reason: 'destroys the dread the mechanic exists for' },
          { option: 'a graphical arc that fills', reason: 'the same information in a prettier costume' },
        ],
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /ALREADY REJECTED: a numeric countdown in the HUD; a graphical arc that fills/,
      'option texts render joined — recognising the thing you were about to propose is what stops you'
    );
    assert.doesNotMatch(ctx, /destroys the dread/, 'REASONS do not render — the option text is the recognition surface, the id carries the rest');
    assert.ok(
      ctx.indexOf('breach timing is never shown') < ctx.indexOf('ALREADY REJECTED'),
      'the statement ORIENTS before the rejected list STOPS'
    );
  } finally {
    cleanup();
  }
});

test('H19: a decision that rejected nothing renders no empty REJECTED line', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(decisionRecord('chose x', ['src/a.mjs'])); // helper defaults alternatives_rejected: []
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ chose x/, 'the statement pointer still renders');
    assert.doesNotMatch(ctx, /ALREADY REJECTED/, 'no empty artifact for a decision with nothing rejected');
  } finally {
    cleanup();
  }
});

test('H19: a long rejected list is clipped to its budget, not emitted whole', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(
      decisionRecord('s', ['src/a.mjs'], {
        alternatives_rejected: Array.from({ length: 12 }, (_, i) => ({
          option: `rejected option number ${i} carrying enough padding text to overrun the budget`,
          reason: 'r',
        })),
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const line = ctx.split('\n').find((l) => l.includes('ALREADY REJECTED'));
    assert.ok(line, 'the rejected line renders');
    assert.ok(line.endsWith('…'), 'and is CLIPPED rather than emitted whole — the flood half of P6 still binds');
    assert.ok(line.length < 200, `the line stays bounded (was ${line.length} chars)`);
  } finally {
    cleanup();
  }
});

test('H19: hazards and decisions are guarded per record like articles — a repeat touch re-delivers nothing', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('latch', ['src/a.mjs']));
    store.create(decisionRecord('chose x', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /ANTI-PATTERN/);
    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'nothing fresh — no second delivery (AC4)');

    // Scope-growth re-arm still holds for a hazard added mid-session.
    store.create(antiPattern('new latch', ['src/a.mjs'], { severity: 'block' }));
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const ctx = JSON.parse(third.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /'new latch'/, 'a NEW hazard mid-session delivers');
    assert.doesNotMatch(ctx, /'latch'\)/, 'the already-delivered hazard does not repeat');
  } finally {
    cleanup();
  }
});

test('H19: a hazard-only touch never denies the tool call (AC7 floor holds on the new path)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'edit' });
  try {
    store.create(antiPattern('latch', ['src/orphan.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/orphan.mjs'), dir);
    assert.notEqual(r.code, 2, 'delivery is an aid, never a gate');
  } finally {
    cleanup();
  }
});

test('H19: capped-away decisions are NOT marked delivered — they surface on the next touch instead of vanishing', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    // 11 decisions governing BOTH files. Guarding all 11 on the first touch used
    // to leave the second file with no DECISIONS block at all — not even a count
    // (correctness review 2026-07-30).
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    for (let i = 0; i < 11; i += 1) store.create(decisionRecord(`choice ${i}`, ['src/a.mjs', 'src/b.mjs']));

    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const firstCtx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.equal(firstCtx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 8, 'the cap still holds on the first touch');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    assert.equal(second.code, 0);
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondCtx, /DECISIONS for this path \(3\)/, 'the 3 never-rendered decisions reach the second file');
    assert.equal(secondCtx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 3);
    assert.doesNotMatch(secondCtx, /NOT shown/, 'nothing is dropped this time, so nothing is disclosed as dropped');

    // And a third touch of the first file re-delivers nothing: everything governing
    // it has now actually been shown.
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(third.stdout, '', 'the guard still converges — no endless re-delivery (AC4)');
  } finally {
    cleanup();
  }
});

test('H19: a one-hop pointer resolves a sibling that loses its own bm25 top-5 — no false "(not in store)"', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('owner', ['src/a.mjs'], { dependencies: { relies_on: ['popular'], relied_by: [] } }));
    store.create(article('popular', ['src/p.mjs'], { what_it_does: 'popular is the sibling that matters' }));
    // Decoys that cite the sibling's slug far more than it names itself — the live
    // shape that made the old ranked cap-5 pointer lookup report it absent
    // (decision 3db7095f).
    for (let i = 0; i < 6; i += 1) {
      store.create(
        article(`citer-${i}`, [`src/c${i}.mjs`], {
          what_it_does: 'popular popular popular popular popular',
          intended_behavior: 'popular popular popular',
        })
      );
    }

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ relies_on \[\[popular\]\]: popular is the sibling that matters/, 'the pointer resolves to real substance');
    assert.doesNotMatch(ctx, /\(not in store\)/, 'a live sibling is never reported absent');
  } finally {
    cleanup();
  }
});

test('H19: a one-hop pointer to a genuinely absent slug still says so', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('owner', ['src/a.mjs'], { dependencies: { relies_on: ['never-written'], relied_by: [] } }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ relies_on \[\[never-written\]\]: \(not in store\)/, 'absence is still reported — the fix removes FALSE absence only');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// BASH POINTER DELIVERY (board 841195b1). Delivery rode Edit|Write|MultiEdit and
// Read only, while surveying happens through grep/wc/git log — the net had a
// hole exactly where the traffic is, and it was SILENT. These tests pin the
// three deliberate differences from full delivery: pointer not article, always
// enqueue (the Bash matcher is an unprobed injection cell), and silence on
// unowned territory. AC7 still holds: no path may exit 2.
// ---------------------------------------------------------------------------

const postBash = (dir, command, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd: dir,
  ...extra,
});

/** The extractor is PURE, so it is tested directly rather than through a hook. */
async function extractor() {
  const m = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  return m.extractCommandPathCandidates;
}

test('bash extractor: keeps real path shapes, drops flags, globs and bare words', async () => {
  const extract = await extractor();
  assert.deepEqual(extract('grep -n needle src/a.mjs'), ['src/a.mjs'], 'flag and pattern dropped, path kept');
  assert.deepEqual(extract('wc -l packages/store/src/index.ts'), ['packages/store/src/index.ts']);
  assert.deepEqual(extract('git log --oneline -5 -- scripts/init.mjs'), ['scripts/init.mjs'], '`--` separator is not a path');
  assert.deepEqual(extract('ls -la'), [], 'no path-shaped token at all');
  assert.deepEqual(extract('rm -rf scripts/tests/*.test.mjs'), [], 'a glob is dropped, never half-expanded');
  assert.deepEqual(extract('cat "packages/a b/c.ts"'), ['packages/a b/c.ts'], 'quoted path with a space is one token');
  assert.deepEqual(extract('sed -n 1,5p scripts/a.mjs:12'), ['scripts/a.mjs'], 'grep -n style path:line is stripped');
  assert.deepEqual(extract('node --test scripts/x.mjs scripts/x.mjs'), ['scripts/x.mjs'], 'deduped');
  assert.deepEqual(extract('echo $HOME/x.ts'), [], 'shell expansion is unresolvable, so dropped');
  assert.deepEqual(extract('cat package.json'), ['package.json'], 'extension with no slash still qualifies');
});

test('bash delivery: an owned path named in a command enqueues a POINTER, not the article', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n export src/a.mjs'), dir);
    assert.equal(r.code, 0, 'AC7: delivery never blocks');
    assert.equal(r.stdout, '', 'rung read notwithstanding, the Bash cell is unprobed — nothing is injected directly');
    const q = pendingOf(dir);
    assert.equal(q.length, 1, 'it went to the proven UserPromptSubmit surface instead');
    assert.equal(q[0].kind, 'bash_pointers');
    assert.match(q[0].payload, /STERLING KNOWLEDGE POINTERS \(H19\)/);
    assert.match(q[0].payload, /src\/a\.mjs — article 'owner' \(active\) · knowledge_get /);
    assert.doesNotMatch(q[0].payload, /does the owner thing/, 'the article BODY is never in a pointer payload');
  } finally {
    cleanup();
  }
});

test('bash delivery: a search PATTERN that looks like a path delivers nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    // 'lib/missing.ts' is the grep PATTERN and exists nowhere: the existence
    // check is what makes a shape-only extractor safe.
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -rn lib/missing.ts .'), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'a non-existent path-shaped token is not a touch');
  } finally {
    cleanup();
  }
});

test('bash delivery: unowned territory is SILENT (no frontier signal on every grep)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lonely.mjs'), 'x\n');
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'wc -l src/lonely.mjs'), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'the frontier signal is right for an edit, wrong for a survey');
  } finally {
    cleanup();
  }
});

test('bash delivery: a directory argument never fans out across the files beneath it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'ls -la src/'), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'ownership is declared per FILE');
  } finally {
    cleanup();
  }
});

test('bash delivery: hazards lead, and are pointed at even in unowned territory', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'h.mjs'), 'x\n');
    store.create(antiPattern('never do the bad thing', ['src/h.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'cat src/h.mjs'), dir);
    assert.equal(r.code, 0);
    const q = pendingOf(dir);
    assert.equal(q.length, 1, 'a hazard alone is worth a pointer even with no owning article');
    assert.match(q[0].payload, /⚠ HAZARD anti_pattern 'never do the bad thing'/);
  } finally {
    cleanup();
  }
});

test('bash delivery: a pointer NEVER suppresses the later full-article delivery for that file', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));

    const bash = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs'), dir);
    assert.equal(bash.code, 0);
    assert.equal(pendingOf(dir).length, 1, 'pointer delivered');

    // The whole point of the separate pointer_files namespace: pointing is not
    // delivering, so a pointer must not cost the reader the real article.
    const read = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(read.code, 0);
    const ctx = JSON.parse(read.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /owning knowledge for 'src\/a\.mjs'/, 'the full article still delivers after a pointer');
    assert.match(ctx, /does the owner thing/, 'and it carries the body the pointer withheld');
  } finally {
    cleanup();
  }
});

test('bash delivery: the same path is pointed at once per session', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs'), dir);
    runHook('h19-bash-delivery.mjs', postBash(dir, 'wc -l src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1, 'the second survey of the same file is silent');
  } finally {
    cleanup();
  }
});

test('bash delivery: a subagent is silent (the pending queue is the conductor\'s)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs', { agent_id: 'coder-1' }), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'enqueueing a subagent touch would mis-route it into the conductor');
  } finally {
    cleanup();
  }
});

test('bash delivery: one command cannot deliver an unbounded number of pointers', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const paths = [];
    for (let i = 0; i < 12; i += 1) {
      const p = `src/f${i}.mjs`;
      writeFileSync(join(dir, p), 'x\n');
      paths.push(p);
      store.create(article(`owner${i}`, [p]));
    }
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, `wc -l ${paths.join(' ')}`), dir);
    assert.equal(r.code, 0);
    const q = pendingOf(dir);
    assert.equal(q.length, 1);
    const lines = q[0].payload.split('\n').filter((l) => l.startsWith('  • '));
    assert.equal(lines.length, 8, 'capped at BASH_POINTER_PATH_CAP');
  } finally {
    cleanup();
  }
});

test('bash delivery: the store tree and .git are never governed territory', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('owner', ['.sterling/config.json']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'cat .sterling/config.json'), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('bash delivery: a malformed or pathless command is a clean no-op', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const cmd of ['', 'ls', 'echo hello world']) {
      const r = runHook('h19-bash-delivery.mjs', postBash(dir, cmd), dir);
      assert.equal(r.code, 0, `AC7 holds for '${cmd}'`);
    }
    const noInput = runHook('h19-bash-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, cwd: dir }, dir);
    assert.equal(noInput.code, 0, 'a missing command string never blocks');
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});
