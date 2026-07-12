import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { scopeCheck } from '../hooks/lib/contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runScript(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
  };
}

function articleRec(slug, files, over = {}) {
  return {
    ...envelope('feature_article'), slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'originating brief' }], live_test_refs: [], ...over,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-modes-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// a brief whose only in-contract file is src/inscope.mjs; everything else is out-of-brief,
// nothing out_of_scope — so only a scope_amendments entry can open another path.
function amendableBrief() {
  return {
    ...envelope('brief'), slug: 'f', title: 'F', problem: 'p', feature: 'f',
    user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src/inscope.mjs', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: [], out_of_scope: [],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

test('scopeCheck: one definition serves run, debug-scope, and direct modes', () => {
  const brief = {
    out_of_scope: ['src/legacy/**'],
    blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }] },
    incidental_scope: ['src/types.mjs'],
  };
  assert.deepEqual(scopeCheck({ brief, rel: 'src/a.mjs' }), {});
  assert.match(scopeCheck({ brief, rel: 'src/legacy/x.mjs' }).deny, /out_of_scope/);
  assert.match(scopeCheck({ brief, rel: 'src/other.mjs' }).deny, /outside the brief/);
  const debugScope = { paths: ['src/cache/**', 'src/a.mjs'] };
  assert.deepEqual(scopeCheck({ debugScope, rel: 'src/cache/store.mjs' }), {});
  assert.match(scopeCheck({ debugScope, rel: 'src/api.mjs' }).deny, /confirm or expand the map/);
  assert.deepEqual(scopeCheck({ rel: 'anything.mjs' }), {}, 'plain direct mode imposes no scope');
});

test('scopeCheck: amendments union into the allowed set AFTER the out_of_scope loop (interface slice 3)', () => {
  const brief = {
    out_of_scope: ['src/legacy/**'],
    blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }] },
    incidental_scope: ['src/types.mjs'],
  };

  // an out-of-brief path becomes in-contract when its exact repo-relative path is amended
  assert.deepEqual(
    scopeCheck({ brief, rel: 'src/other.mjs', amendments: ['src/other.mjs'] }),
    {},
    'an amended exact path is unioned into the allowed set'
  );

  // KEY ADVERSARIAL: an amended path that ALSO matches an out_of_scope glob stays DENIED —
  // the union happens AFTER the out_of_scope denial loop, so ordering is load-bearing.
  assert.match(
    scopeCheck({ brief, rel: 'src/legacy/x.mjs', amendments: ['src/legacy/x.mjs'] }).deny,
    /out_of_scope/,
    'out_of_scope denial precedes the amendment union — an amendment can never open an out_of_scope path'
  );

  // an unrelated amendment does not open OTHER out-of-brief paths (exact match only, no globbing)
  assert.match(
    scopeCheck({ brief, rel: 'src/other.mjs', amendments: ['src/somethingelse.mjs'] }).deny,
    /outside the brief/
  );

  // omitting amendments (or []) is byte-identical to today's behavior — back-compat
  assert.deepEqual(scopeCheck({ brief, rel: 'src/a.mjs' }), {});
  assert.deepEqual(scopeCheck({ brief, rel: 'src/a.mjs', amendments: [] }), {}, 'empty amendments === omission');
  assert.match(scopeCheck({ brief, rel: 'src/other.mjs', amendments: [] }).deny, /outside the brief/);
});

test('debug-scope CLI registers/clears; H3 enforces the map in direct mode', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'inmap.mjs'), 'x');
    writeFileSync(join(dir, 'src', 'outside.mjs'), 'x');
    assert.equal(runScript('debug-scope.mjs', ['register', '--path', 'src/inmap.mjs', '--target', dir], dir).code, 0);

    const h3 = (file) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h3-contract-gate.mjs')], {
        input: JSON.stringify({ session_id: 's', transcript_path: 't', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, file) } }),
        encoding: 'utf8', cwd: dir, timeout: 30_000,
      });
    const denied = h3('src/outside.mjs');
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /debug-scope mode.*confirm or expand/s);

    // in-map still needs read-evidence (direct rules compose)
    const needsRead = h3('src/inmap.mjs');
    assert.equal(needsRead.status, 2);
    assert.match(needsRead.stderr, /read-evidence/);

    assert.equal(runScript('debug-scope.mjs', ['clear', '--target', dir], dir).code, 0);
    const afterClear = h3('src/outside.mjs');
    assert.match(afterClear.stderr, /read-evidence/, 'map cleared: back to plain direct mode');
  } finally {
    cleanup();
  }
});

test('fs-remove: contract-checked; refuses out-of-contract in run mode; registers reconcile touches', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const article = store.create(articleRec('feat-a', ['src/dead.mjs']));
    writeFileSync(join(dir, 'src', 'dead.mjs'), 'x');
    writeFileSync(join(dir, 'src', 'precious.mjs'), 'x');

    // direct mode removal: succeeds + maintenance item for the owner
    const ok = runScript('fs-remove.mjs', ['src/dead.mjs', '--target', dir], dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(existsSync(join(dir, 'src', 'dead.mjs')), false);
    const queue = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].feature_link, article.id);

    // run mode: out-of-contract removal refused, nothing deleted
    const brief = store.create({
      ...envelope('brief'), slug: 'f', title: 'F', problem: 'p', feature: 'f',
      user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({ id: 'r-m', brief_ref: brief.id, branch: 'b', machine_state: 'running', phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW });
    const refused = runScript('fs-remove.mjs', ['src/precious.mjs', '--target', dir], dir);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /REFUSED.*outside the brief/s);
    assert.ok(existsSync(join(dir, 'src', 'precious.mjs')), 'refusal deletes nothing');
  } finally {
    cleanup();
  }
});

test('fs-move/fs-remove: fail closed when a run is active but its brief is unresolvable (audit finding 20/43)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'victim.mjs'), 'export const x = 1;'); // dest.mjs intentionally absent
    // run points at a brief_ref that does not resolve to a brief record
    store.createRun({
      id: 'r-dangle', brief_ref: randomUUID(), branch: 'b', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
    });

    const rm = runScript('fs-remove.mjs', ['src/victim.mjs', '--target', dir], dir);
    assert.equal(rm.code, 2, 'fs-remove refuses on a dangling brief_ref');
    assert.match(rm.stderr, /failing closed/);
    assert.ok(existsSync(join(dir, 'src', 'victim.mjs')), 'nothing deleted');

    const mv = runScript('fs-move.mjs', ['src/victim.mjs', 'src/dest.mjs', '--target', dir], dir);
    assert.equal(mv.code, 2, 'fs-move refuses on a dangling brief_ref');
    assert.match(mv.stderr, /failing closed/);
    assert.ok(existsSync(join(dir, 'src', 'victim.mjs')), 'nothing moved');
  } finally {
    cleanup();
  }
});

test('fs-remove: a run.scope_amendments path is in-contract — out-of-brief removal allowed (scopeCheck amendments consumer)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'amended.mjs'), 'export const x = 1;');
    const brief = store.create(amendableBrief());
    // seed the amendment as run data — before the feature ships the schema strips it, so the
    // run resolves with no amendments and fs-remove REFUSES (assertion-red); once shipped it allows.
    store.createRun({
      id: 'r-am', brief_ref: brief.id, branch: 'b', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
      scope_amendments: [{ path: 'src/amended.mjs', reason: 'adjudicated mid-run', at: NOW }],
    });
    const r = runScript('fs-remove.mjs', ['src/amended.mjs', '--target', dir], dir);
    assert.equal(r.code, 0, `an amended out-of-brief path removal must be allowed — ${r.stderr}`);
    assert.equal(existsSync(join(dir, 'src', 'amended.mjs')), false, 'amended file removed');
  } finally {
    cleanup();
  }
});

test('fs-move: renames AND rewrites file_keys on every owning record — knowledge never orphaned (§7.1)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const article = store.create(articleRec('feat-m', ['src/old-name.mjs'], { live_test_refs: [{ ac_id: 'AC1', test_paths: ['src/old-name.mjs'] }] }));
    store.create({ ...envelope('decision'), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/old-name.mjs'] });
    writeFileSync(join(dir, 'src', 'old-name.mjs'), 'export const x = 1;');

    const r = runScript('fs-move.mjs', ['src/old-name.mjs', 'src/new-name.mjs', '--target', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).records_rewritten, 2);
    assert.ok(existsSync(join(dir, 'src', 'new-name.mjs')));

    assert.equal(store.query({ file_keys: ['src/old-name.mjs'], cap: 10 }).length, 0, 'old key joins nothing');
    const byNew = store.query({ file_keys: ['src/new-name.mjs'], cap: 10 });
    assert.equal(byNew.length, 2, 'both owners follow the move');
    const movedArticle = store.get(article.id);
    assert.equal(movedArticle.files[0].path, 'src/new-name.mjs');
    assert.equal(movedArticle.live_test_refs[0].test_paths[0], 'src/new-name.mjs');
  } finally {
    cleanup();
  }
});

test('fs-move: a run.scope_amendments path is in-contract — move of an out-of-brief file allowed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'amended.mjs'), 'export const x = 1;');
    const brief = store.create(amendableBrief());
    // amend BOTH endpoints so the move is in-contract regardless of which side fs-move scope-checks
    store.createRun({
      id: 'r-am2', brief_ref: brief.id, branch: 'b', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
      scope_amendments: [
        { path: 'src/amended.mjs', reason: 'adjudicated mid-run', at: NOW },
        { path: 'src/moved.mjs', reason: 'destination adjudicated', at: NOW },
      ],
    });
    const r = runScript('fs-move.mjs', ['src/amended.mjs', 'src/moved.mjs', '--target', dir], dir);
    assert.equal(r.code, 0, `an amended-path move must be allowed — ${r.stderr}`);
    assert.ok(existsSync(join(dir, 'src', 'moved.mjs')), 'file moved to the amended destination');
    assert.equal(existsSync(join(dir, 'src', 'amended.mjs')), false, 'source gone after the move');
  } finally {
    cleanup();
  }
});

test('cleanup-plan: dormant/deprecated candidates with dependency evidence; active dependents block (§8.4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const dead = store.create(articleRec('dead-feat', ['src/dead.mjs'], { state: 'deprecated' }));
    const blockedDep = store.create(articleRec('blocked-feat', ['src/blocked.mjs'], { state: 'dormant', state_reason: 'r', wiring_todo_id: randomUUID() }));
    store.create(articleRec('consumer', ['src/consumer.mjs'], { dependencies: { relies_on: [blockedDep.id], relied_by: [] } }));
    store.create({ ...envelope('todo'), text: 'delete old export path', source: 'system', system_reason: 'deletion_candidate', file_keys: ['src/dead.mjs'] });

    const r = runScript('cleanup-plan.mjs', ['--target', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    const deadC = plan.candidates.find((c) => c.article === dead.id);
    const blockedC = plan.candidates.find((c) => c.article === blockedDep.id);
    assert.equal(deadC.deletable, true);
    assert.equal(blockedC.deletable, false);
    assert.equal(blockedC.active_dependents[0].slug, 'consumer');
    assert.equal(plan.queue.length, 1);
  } finally {
    cleanup();
  }
});
