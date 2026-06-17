import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { selectReviewers } from '../lib/reviewer-selection.mjs';
import { runWiringCheck } from '../lib/wiring-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
let ProjectRegistry;
let parseConfig;
before(async () => {
  ({ SterlingStore, ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ parseConfig } = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject({ withRun = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h5-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  let run;
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
    run = store.createRun({
      id: 'r-h5',
      brief_ref: brief.id,
      branch: 'sterling/run-r-h5',
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
  return { dir, store, run, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function article(store, slug, files) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
}

// --------------------------- H1 ---------------------------

test('H1: banner art to stderr (env-only suppression), counts to the human, conventions to Claude; quiet outside Sterling projects', () => {
  const ART_ROW = '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀'; // letterform row 3
  const { dir, store, cleanup } = makeProject();
  try {
    store.create({ ...envelope('todo'), text: 'a', source: 'user' });
    store.create({ ...envelope('todo'), text: 'b', source: 'user' });
    store.create({ ...envelope('todo'), text: 'm', source: 'system', system_reason: 'reconcile_needed' });
    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /^2 todos · 1 maintenance item pending/);
    assert.match(out.hookSpecificOutput.additionalContext, /Anti-speculation/);
    assert.ok(r.stderr.includes(ART_ROW), 'banner art on stderr');
    assert.ok(!r.stderr.includes('\x1b['), 'NO_COLOR strips ANSI');
    assert.match(r.stderr, /v\d+\.\d+\.\d+/, 'plugin version read live (fail-open contract)');
    const colored = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '' });
    assert.ok(colored.stderr.includes('\x1b[38;2;'), 'truecolor gradient by default');
    const suppressed = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { STERLING_NO_BANNER: '1' });
    assert.equal(suppressed.code, 0);
    assert.ok(!suppressed.stderr.includes('▀'), 'STERLING_NO_BANNER=1 silences the art');
    assert.match(JSON.parse(suppressed.stdout).systemMessage, /^2 todos/, 'counts line survives suppression');
  } finally {
    cleanup();
  }
  const bare = mkdtempSync(join(tmpdir(), 'sterling-bare-'));
  try {
    const r = runHook('h1-session-start.mjs', hookInput(bare, { hook_event_name: 'SessionStart' }), bare);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'no ceremony outside Sterling projects (P1)');
    assert.ok(!r.stderr.includes('▀'), 'no banner art outside Sterling projects (P1)');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('H1: shared project registry — touches this project last_seen + makes the CONDUCTOR aware of live siblings via additionalContext, not systemMessage (decision 8f9e6db2)', () => {
  const { dir, cleanup } = makeProject();
  const regPath = join(dir, 'registry.db');
  const cwdPosix = dir.replace(/\\/g, '/');
  try {
    const seed = new ProjectRegistry(regPath);
    try {
      seed.register({ repo_path: cwdPosix, name: 'current', stack_tags: ['node'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW });
      seed.register({ repo_path: root.replace(/\\/g, '/'), name: 'sib-live', stack_tags: ['node'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW }); // root exists
      seed.register({ repo_path: 'C:/nope/gone-xyz', name: 'sib-missing', stack_tags: ['genesys'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW });
    } finally {
      seed.close();
    }

    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1', STERLING_REGISTRY_DB: regPath });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    // CONDUCTOR awareness goes to additionalContext (Claude's context), with the
    // live sibling + its domains; the human systemMessage stays counts-only.
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Sibling Sterling projects/);
    assert.match(ctx, /- sib-live: node/, 'live sibling listed with its domains');
    assert.match(ctx, /Anti-speculation/, 'conventions still present');
    assert.doesNotMatch(ctx, /sib-missing/, 'a missing (stale) sibling is excluded from conductor awareness');
    assert.doesNotMatch(out.systemMessage, /sibling/, 'the human systemMessage is not used for sibling awareness');
    assert.match(out.systemMessage, /pending$/, 'systemMessage is counts-only');

    // last_seen touched for THIS project only
    const after = new ProjectRegistry(regPath);
    try {
      const me = after.list().find((p) => p.repo_path === cwdPosix);
      assert.ok(me.last_seen_at && /^\d{4}-\d{2}-\d{2}T/.test(me.last_seen_at), 'this project last_seen_at touched at session start');
      assert.equal(after.list().find((p) => p.repo_path === 'C:/nope/gone-xyz').last_seen_at, null, 'a sibling is NOT touched');
    } finally {
      after.close();
    }
  } finally {
    cleanup();
  }
});

// --------------------------- H2 ---------------------------

test('H2: selection row consumed one-shot, transactionally, from the store — never a file (P4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create({ ...envelope('decision'), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    store.writeSelection('decision', d.id, NOW);
    const r1 = runHook('h2-selection-inject.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.match(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext, new RegExp(d.id));
    const r2 = runHook('h2-selection-inject.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r2.stdout, '', 'one-shot: second prompt sees nothing');
    assert.equal(existsSync(join(dir, '.sterling', 'selection.json')), false, 'no signal file exists');
  } finally {
    cleanup();
  }
});

// --------------------------- H4 ---------------------------

test('H4: test-writer read wall — denies implementation, allows tests/docs/outside-repo', () => {
  const { dir, cleanup } = makeProject();
  try {
    const read = (p) => runHook('h4-read-wall.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: p } }), dir);
    let r = read(join(dir, 'src', 'impl.mjs'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /never reads code/);
    assert.equal(read(join(dir, 'tests', 'x.test.mjs')).code, 0);
    assert.equal(read(join(dir, 'README.md')).code, 0);
    assert.equal(read(join(dir, 'docs', 'guide.txt')).code, 0);
    assert.equal(read('C:/elsewhere/platform-notes.ts').code, 0, 'outside the repo is not implementation');
  } finally {
    cleanup();
  }
});

// --------------------------- H7 ---------------------------

test('H7 [pipeline]: owning articles land on run.reconcile_needed, idempotently', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const a = article(store, 'feat-a', ['src/a.mjs']);
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    assert.deepEqual(store.getRun('r-h5').reconcile_needed, [a.id], 'marked once, not duplicated');
  } finally {
    cleanup();
  }
});

test('H7 [direct]: maintenance queue item (deduped) + transient touch register for H10', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const a = article(store, 'feat-a', ['src/a.mjs']);
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    const queue = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(queue.length, 1, 'deduped per article');
    assert.equal(queue[0].feature_link, a.id);
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(touches.length, 2);
    assert.equal(touches[0].path, 'src/a.mjs');

    // .git/** is machinery, never governed work (live incident 2026-06-12:
    // a commit-message temp file fed H10 a junk article demand)
    const gitWrite = runHook(
      'h7-file-touch.mjs',
      hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, '.git', 'COMMIT_MSG_TMP.txt') } }),
      dir
    );
    assert.equal(gitWrite.code, 0);
    const after = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(after.length, 2, '.git/** paths never enter the touch register');
  } finally {
    cleanup();
  }
});

function referenceDoc(store, title, kind, location) {
  return store.create({
    ...envelope('reference_material'),
    title,
    kind,
    location,
    summary: 'section map',
    source_date: NOW,
    capture_date: NOW,
    basis: 'codebase',
  });
}

test('H7 [§3.2.5 direct]: repo-located reference doc trips reconcile_needed (deduped); url-kind trips nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const doc = referenceDoc(store, 'Build Spec', 'doc', 'docs/spec.md');
    referenceDoc(store, 'External', 'url', 'https://example.com/spec');
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'docs', 'spec.md') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    const queue = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(queue.length, 1, 'doc reference marked once (deduped); the url reference never');
    assert.equal(queue[0].feature_link, doc.id);
    assert.match(queue[0].text, /refresh summary \+ source_date/);
  } finally {
    cleanup();
  }
});

test('H7 [§3.2.5 pipeline]: a Sterling-governed touch lands the reference doc on run.reconcile_needed', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const doc = referenceDoc(store, 'Build Spec', 'doc', 'docs/spec.md');
    const r = runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'docs', 'spec.md') } }), dir);
    assert.equal(r.code, 0);
    assert.deepEqual(store.getRun('r-h5').reconcile_needed, [doc.id]);
  } finally {
    cleanup();
  }
});

// --------------------------- H8 ---------------------------

test('H8: dispatch cap — probe-verified blocking PreToolUse on the Agent tool', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const spawn = () =>
      runHook('h8-dispatch-cap.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'go' } }), dir);
    store.updateRunOptimistic('r-h5', (run) => ({ ...run, dispatch_counts: { coder: 24 } }));
    assert.equal(spawn().code, 0, '25th dispatch is within the cap');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 25);
    const denied = spawn();
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /dispatch cap exceeded/);
    assert.ok(store.getRun('r-h5').escalations.some((e) => e.kind === 'dispatch_cap_exceeded'), 'deny + escalate (§6 H8)');
  } finally {
    cleanup();
  }
  const noRun = makeProject();
  try {
    const r = runHook('h8-dispatch-cap.mjs', hookInput(noRun.dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder' } }), noRun.dir);
    assert.equal(r.code, 0, 'the cap is per-run');
  } finally {
    noRun.cleanup();
  }
});

// --------------------------- H9 ---------------------------

test('H9: Stop blocked only while completing, naming outstanding promotion conditions; loop-guarded', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const stop = (over = {}) => runHook('h9-stop-backstop.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);
    assert.equal(stop().code, 0, 'running: stopping is not H9 business');

    store.casTransition('running', { ...store.getRun('r-h5'), machine_state: 'completing' });
    const blocked = stop();
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /mid-completion/);
    assert.match(blocked.stderr, /feature_article_missing/, 'outstanding conditions are named from the shared promotion definition');
    assert.equal(stop({ stop_hook_active: true }).code, 0, 'loop guard');

    store.casTransition('completing', { ...store.getRun('r-h5'), machine_state: 'awaiting_merge_gate' });
    assert.equal(stop().code, 0, 'awaiting_merge_gate: stopping is legitimate (the human decides at leisure)');
  } finally {
    cleanup();
  }
});

// --------------------------- H10 ---------------------------

test('H10: capture nag once with reviewer selection, then capture_owed and release; capture clears it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), '// x\n');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/auth/login.mjs', at: NOW }]));
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);

    const nag = stop();
    assert.equal(nag.code, 2);
    assert.match(nag.stderr, /nothing was captured/);
    assert.match(nag.stderr, /"reviewer":"correctness"/, 'deterministic reviewer selection is included');
    assert.match(nag.stderr, /"reviewer":"security"/, 'auth/ path signal dispatches security');

    const second = stop();
    assert.equal(second.code, 0, 'second stop releases the session');
    const owed = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');
    assert.equal(owed.length, 1);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
  const captured = makeProject();
  try {
    mkdirSync(join(captured.dir, 'src'), { recursive: true });
    writeFileSync(join(captured.dir, 'src', 'a.mjs'), '// x\n');
    mkdirSync(join(captured.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(captured.dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/a.mjs', at: NOW }]));
    captured.store.create({ ...envelope('decision', '2026-06-10T13:00:00.000Z'), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const r = runHook('h10-direct-capture.mjs', hookInput(captured.dir, { hook_event_name: 'Stop' }), captured.dir);
    assert.equal(r.code, 0, 'capture after the touches satisfies H10');
    assert.equal(existsSync(join(captured.dir, '.sterling', 'transient', 'touches.json')), false);
  } finally {
    captured.cleanup();
  }
});

function touchRegister(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: NOW }))));
}

function captureNote(store) {
  store.create({ ...envelope('note', '2026-06-10T13:00:00.000Z'), raw_text: 'learned things', captured_at: NOW, capture_source: 'conductor', derived: [] });
}

test('H10 article demand (§6): capture alone does not satisfy unowned territory at threshold; article_missing survives the session', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureNote(store);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'capture alone does not satisfy the article demand');
    assert.match(nag.stderr, /article demand/);
    assert.match(nag.stderr, /no owner \(feature_article or repo-located reference doc\)/);
    assert.doesNotMatch(nag.stderr, /nothing was captured/, 'the capture duty itself is satisfied');

    const release = stop();
    assert.equal(release.code, 0, 'second stop releases the session (P1)');
    const missing = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');
    assert.equal(missing.length, 1, 'the owed article survives as a durable item');
    assert.deepEqual([...missing[0].file_keys].sort(), ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
});

test('H10 article demand: creating the owning article clears the demand mechanically; under-threshold stays note-level', () => {
  const owned = makeProject();
  try {
    touchRegister(owned.dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureNote(owned.store);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(owned.dir, { hook_event_name: 'Stop' }), owned.dir);
    assert.equal(stop().code, 2, 'demand raised');
    article(owned.store, 'feat-x', ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    assert.equal(stop().code, 0, 'ownership satisfies the demand');
    assert.equal(owned.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0, 'no item once owned');
  } finally {
    owned.cleanup();
  }
  const small = makeProject();
  try {
    touchRegister(small.dir, ['src/x.mjs', 'src/y.mjs']);
    captureNote(small.store);
    const r = runHook('h10-direct-capture.mjs', hookInput(small.dir, { hook_event_name: 'Stop' }), small.dir);
    assert.equal(r.code, 0, 'two unowned files are under the default threshold of 3');
    assert.equal(small.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0);
  } finally {
    small.cleanup();
  }
  // a governing document's owner is its repo-located reference_material record
  // (§3.2.5) — the demand join matches H7's (adjudicated 2026-06-12 after the
  // spec itself was demanded a feature article); 3 docs = at threshold, so this
  // passes ONLY through the reference_material side of the join
  const docs = makeProject();
  try {
    touchRegister(docs.dir, ['docs/a.md', 'docs/b.md', 'docs/c.md']);
    captureNote(docs.store);
    referenceDoc(docs.store, 'Doc A', 'doc', 'docs/a.md');
    referenceDoc(docs.store, 'Doc B', 'doc', 'docs/b.md');
    referenceDoc(docs.store, 'Doc C', 'doc', 'docs/c.md');
    const r = runHook('h10-direct-capture.mjs', hookInput(docs.dir, { hook_event_name: 'Stop' }), docs.dir);
    assert.equal(r.code, 0, 'reference-doc ownership satisfies the article demand');
    assert.equal(docs.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0);
  } finally {
    docs.cleanup();
  }
});

test('H10 article demand: an open article_missing item with overlapping file keys is not duplicated', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureNote(store);
    store.create({
      ...envelope('todo'),
      text: 'article missing: earlier session',
      source: 'system',
      system_reason: 'article_missing',
      file_keys: ['src/x.mjs'],
      author: 'system',
    });
    // a non-overlapping article_missing item (other territory) must NOT suppress —
    // pins overlap-scoped dedup against a reason-wide-dedup mutant
    store.create({
      ...envelope('todo'),
      text: 'article missing: unrelated territory',
      source: 'system',
      system_reason: 'article_missing',
      file_keys: ['lib/unrelated.mjs'],
      author: 'system',
    });
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(stop().code, 2);
    assert.equal(stop().code, 0);
    const items = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');
    assert.equal(items.length, 2, 'overlapping item dedupes; non-overlapping item does not suppress');
    assert.ok(
      items.every((t) => !t.text.includes('direct-mode work touched')),
      'no NEW item was enqueued — the overlapping seed suppressed it'
    );
  } finally {
    cleanup();
  }
});

test('H10: a touched file deleted before Stop is skipped — no demand, no article_missing (created-then-deleted needs no owner)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // touches registered for paths that do NOT exist on disk (created then rm'd in-session;
    // raw rm leaves the H7 entry stale). H10 must not demand an owner for a deleted file.
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(
      join(dir, '.sterling', 'transient', 'touches.json'),
      JSON.stringify([{ path: 'scripts/_throwaway.mjs', at: NOW }, { path: 'src/also-gone.mjs', at: NOW }])
    );
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'no demand for files that no longer exist');
    const items = store.query({ types: ['todo'], cap: 100 });
    assert.equal(items.filter((t) => t.system_reason === 'article_missing').length, 0, 'no article_missing for a deleted file');
    assert.equal(items.filter((t) => t.system_reason === 'capture_owed').length, 0, 'no capture_owed — no durable change remained');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
});

// --------------------------- H15 ---------------------------

test('H15 store guard: shell references to the store are denied naming the §10 tools; sanctioned scripts and unrelated commands pass', () => {
  const { dir, cleanup } = makeProject();
  try {
    const run = (command) =>
      runHook('h15-store-guard.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } }), dir);

    const nodeWrite = run(`node -e "import('.../store/dist/index.js').then(s => new s.SterlingStore('.sterling/sterling.db'))"`);
    assert.equal(nodeWrite.code, 2, 'ad-hoc node script against the store is denied');
    assert.match(nodeWrite.stderr, /§10 MCP tool surface/);
    assert.match(nodeWrite.stderr, /note_remove/, 'the deny message teaches the full write surface, note_remove included');
    assert.match(nodeWrite.stderr, /RESTART THE SESSION/);

    assert.equal(run('sqlite3 .sterling/sterling.db "SELECT * FROM records"').code, 2, 'reads are denied too — use knowledge_query');
    assert.equal(run('Get-Content .sterling\\config.json').code, 2, 'backslash store paths are caught');

    assert.equal(run('node scripts/dispose-run.mjs r-0001 --store .sterling/sterling.db').code, 0, 'sanctioned script passes');
    assert.equal(run('node scripts/init.mjs --backup-path .sterling/backups').code, 0, 'init passes');
    assert.equal(run('node packages/tui/bundle/sterling-tui.mjs --store .sterling/sterling.db').code, 0, 'TUI launcher passes');
    assert.equal(run('npm test').code, 0, 'unrelated commands untouched');
    assert.equal(run('git status').code, 0);

    // malformed config: the gate FAILS CLOSED on the protected branch (review finding)
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const broken = run('sqlite3 .sterling/sterling.db ".tables"');
    assert.equal(broken.code, 2, 'unreadable config denies rather than voiding the gate');
    assert.match(broken.stderr, /fails closed/);
  } finally {
    cleanup();
  }
  // outside a Sterling project: silent pass-through (P1)
  const bare = mkdtempSync(join(tmpdir(), 'sterling-bare-'));
  try {
    const r = runHook(
      'h15-store-guard.mjs',
      hookInput(bare, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sqlite3 .sterling/sterling.db ".tables"' } }),
      bare
    );
    assert.equal(r.code, 0, 'no ceremony outside Sterling projects');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// --------------------------- H11 ---------------------------

test('H11: extraction lands as derived_unconfirmed citing the note; failure degrades loudly', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const note = store.create({
      ...envelope('note'),
      raw_text: 'genesys rate limits are per-org; we chose queue-level retries over global backoff',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    const fake = join(dir, 'fake-extractor.mjs');
    writeFileSync(
      fake,
      `process.stdout.write(JSON.stringify([{ type: 'decision', fields: { title: 'Queue-level retries', statement: 'Retry per queue, not global backoff.', alternatives_rejected: [{option:'global backoff',reason:'starves hot queues'}], rationale: 'per-org limits' } }]));`
    );
    const input = hookInput(dir, {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__sterling__knowledge_create',
      tool_input: { type: 'note', fields: { raw_text: note.raw_text } },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ record: { id: note.id } }) }] },
    });
    const r = runHook('h11-note-structure.mjs', input, dir, { STERLING_H11_EXTRACTOR: fake });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 derived_unconfirmed candidate/);

    const hidden = store.query({ types: ['decision'], cap: 10 });
    assert.equal(hidden.length, 0, 'derived_unconfirmed excluded from default retrieval (§3.2.6)');
    const visible = store.query({ types: ['decision'], include_unconfirmed: true, cap: 10 });
    assert.equal(visible.length, 1);
    assert.equal(visible[0].derived_unconfirmed, true);
    assert.ok(visible[0].links.some((l) => l.rel === 'cites' && l.target_id === note.id), 'extraction cites the note');
    assert.deepEqual(store.get(note.id).derived, [visible[0].id], "note.derived[] updated; raw_text untouched");

    const failing = join(dir, 'failing-extractor.mjs');
    writeFileSync(failing, 'process.exit(1);');
    const degraded = runHook('h11-note-structure.mjs', input, dir, { STERLING_H11_EXTRACTOR: failing });
    assert.equal(degraded.code, 0);
    assert.match(degraded.stderr, /degraded loudly/);
    assert.ok(store.listCheckSkipped().some((s) => s.check_name === 'note-structuring-h11' && s.reason === 'extractor_failed'));
  } finally {
    cleanup();
  }
});

// --------------------------- reviewer selection + H12 units ---------------------------

test('reviewer-selection: deterministic, logs why dispatched AND why skipped (§7.1)', () => {
  const config = parseConfig({});
  const sel = (diff, brief) => selectReviewers({ config, diff, brief });
  const base = sel([{ path: 'src/util.mjs', added_lines: ['export const x = 1;'] }]);
  assert.deepEqual(base.dispatch.map((d) => d.reviewer), ['correctness'], 'correctness is the floor');
  assert.equal(base.skipped.length, 3, 'every non-dispatch is explained');
  assert.ok(base.skipped.every((s) => s.why.length > 0));

  assert.ok(sel([{ path: 'src/auth/login.mjs', added_lines: [] }]).dispatch.some((d) => d.reviewer === 'security'), 'path signal');
  assert.ok(sel([{ path: 'src/x.mjs', added_lines: ['const q = "SELECT * FROM t WHERE id=" + id;'] }]).dispatch.some((d) => d.reviewer === 'security'), 'content signal');
  assert.ok(sel([{ path: 'package.json', added_lines: [] }]).dispatch.some((d) => d.reviewer === 'security'), 'dependency manifest');
  assert.ok(sel([{ path: 'src/x.mjs', added_lines: [] }], { risk_flags: ['perf_sensitive'] }).dispatch.some((d) => d.reviewer === 'performance'), 'brief risk flag');
  const bigDiff = [{ path: 'src/big.mjs', added_lines: Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`) }];
  assert.ok(sel(bigDiff).dispatch.some((d) => d.reviewer === 'skeptic'), 'size threshold');
  assert.deepEqual(sel([]).dispatch, [], 'no diff, no reviewers');
});

test('H12 wiring check: capability-absent skips loudly; offenders block; dormancy routes to wire_in_dormant', () => {
  const { store, cleanup } = makeProject();
  try {
    const absent = runWiringCheck({ adapterModule: { name: 'node', capabilities: { static_wiring: false } }, cwd: '.', scope: [], store, now: NOW });
    assert.deepEqual(absent.skipped, { check: 'wiring-zero-consumer', reason: 'capability_absent:node' });

    const capable = {
      name: 'fake',
      capabilities: { static_wiring: true },
      staticWiring: () => ({ test_only_exports: [{ file: 'src/a.mjs', name: 'exportedButUnwired' }] }),
    };
    const blocked = runWiringCheck({ adapterModule: capable, cwd: '.', scope: [], article: undefined, store, now: NOW });
    assert.equal(blocked.violations.length, 1);
    assert.match(blocked.violations[0], /built-but-not-wired/);

    const dormant = store.create({
      ...envelope('feature_article'),
      slug: 'dormant-feat',
      title: 'd',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'dormant',
      state_reason: 'wired next phase',
      wiring_todo_id: randomUUID(),
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const declared = runWiringCheck({ adapterModule: capable, cwd: '.', scope: [], article: dormant, store, now: NOW });
    assert.deepEqual(declared.violations, []);
    assert.equal(declared.dormant, true);
    const todo = store.get(declared.wire_in_dormant_todo);
    assert.equal(todo.system_reason, 'wire_in_dormant', 'declared dormancy is tracked, never silent');
  } finally {
    cleanup();
  }
});

// --------------------------- dispose-run union (H7 → promotion) ---------------------------

test('dispose-run verifies the union: H7-accumulated reconcile_needed blocks disposal until reconciled', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ ...CONFIG, backup_path: join(dir, 'backups').replace(/\\/g, '/') })
    );
    // article created BEFORE the run, marked by H7 mid-run, never reconciled
    const stale = store.create({
      ...envelope('feature_article', '2026-06-09T12:00:00.000Z'),
      slug: 'stale-feat',
      title: 's',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: '2026-06-09T12:00:00.000Z', event: 'originating brief' }],
      live_test_refs: [],
    });
    store.updateRunOptimistic('r-h5', (run) => ({ ...run, reconcile_needed: [stale.id] }));
    // every other condition passes
    const brief = store.get(store.getRun('r-h5').brief_ref);
    store.create({
      ...envelope('feature_article', '2026-06-10T13:00:00.000Z'),
      slug: 'f',
      title: 'F',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief', target_id: brief.id }],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests/x.test.mjs'] }],
    });
    store.casTransition('running', { ...store.getRun('r-h5'), machine_state: 'completing' });

    const dispose = () =>
      spawnSync(process.execPath, [join(root, 'scripts', 'dispose-run.mjs'), '--run', 'r-h5', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    const refused = dispose();
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr ?? '', new RegExp(`article_unreconciled.*${stale.id}`));

    // reconciling the H7-marked article clears the refusal
    store.supersede(stale.id, {
      ...stale,
      id: randomUUID(),
      version: 2,
      what_it_does: 'reconciled',
      created_at: '2026-06-10T14:00:00.000Z',
      updated_at: '2026-06-10T14:00:00.000Z',
      status: 'active',
      superseded_by: null,
      links: [],
    });
    const ok = dispose();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally {
    cleanup();
  }
});
