import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

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
    // the two knowledge owners follow the move (excluding the reconcile todo, which
    // also carries the new key — see the direct-mode reconcile assertion below)
    const byNew = store.query({ file_keys: ['src/new-name.mjs'], cap: 10 }).filter((r) => r.type !== 'todo');
    assert.equal(byNew.length, 2, 'both owners follow the move');
    const movedArticle = store.get(article.id);
    assert.equal(movedArticle.files[0].path, 'src/new-name.mjs');
    assert.equal(movedArticle.live_test_refs[0].test_paths[0], 'src/new-name.mjs');

    // direct mode (no run): a reconcile_needed maintenance item must exist for the
    // owning article, matching fs-remove's semantics (audit finding 36/43).
    const reconcile = store.query({ types: ['todo'], cap: 100 })
      .filter((t) => t.system_reason === 'reconcile_needed' && t.feature_link === article.id);
    assert.equal(reconcile.length, 1, 'fs-move registers a direct-mode reconcile obligation like fs-remove');
    assert.match(reconcile[0].text, /renamed/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: dormant/deprecated candidates with dependency evidence; active dependents block (§8.4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const dead = store.create(articleRec('dead-feat', ['src/dead.mjs'], { state: 'deprecated' }));
    const blockedDep = store.create(articleRec('blocked-feat', ['src/blocked.mjs'], { state: 'dormant', state_reason: 'r', wiring_todo_id: randomUUID() }));
    const legacyDep = store.create(articleRec('legacy-feat', ['src/legacy.mjs'], { state: 'deprecated' }));
    // relies_on holds SLUGS (decision foreign_474b1c71); id-based references still block as a legacy fallback.
    store.create(articleRec('consumer', ['src/consumer.mjs'], { dependencies: { relies_on: ['blocked-feat'], relied_by: [] } }));
    store.create(articleRec('legacy-consumer', ['src/legacy-consumer.mjs'], { dependencies: { relies_on: [legacyDep.id], relied_by: [] } }));
    // a dependent that is itself a cleanup candidate is not "active" — it must not block.
    store.create(articleRec('old-consumer', ['src/old-consumer.mjs'], { state: 'deprecated', dependencies: { relies_on: ['dead-feat'], relied_by: [] } }));
    store.create({ ...envelope('todo'), text: 'delete old export path', source: 'system', system_reason: 'deletion_candidate', file_keys: ['src/dead.mjs'] });

    const r = runScript('cleanup-plan.mjs', ['--target', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    const deadC = plan.candidates.find((c) => c.article === dead.id);
    const blockedC = plan.candidates.find((c) => c.article === blockedDep.id);
    const legacyC = plan.candidates.find((c) => c.article === legacyDep.id);
    assert.equal(deadC.deletable, true, 'a deprecated dependent must not block deletion');
    assert.equal(blockedC.deletable, false, 'a slug-referencing active dependent blocks');
    assert.equal(blockedC.active_dependents[0].slug, 'consumer');
    assert.equal(legacyC.deletable, false, 'a legacy id-referencing active dependent still blocks');
    assert.equal(legacyC.active_dependents[0].slug, 'legacy-consumer');
    assert.equal(plan.queue.length, 1);
  } finally {
    cleanup();
  }
});
