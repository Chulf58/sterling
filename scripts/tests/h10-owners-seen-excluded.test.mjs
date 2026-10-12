// H10 article demand: the "owners seen" note must say when a listed owner was
// EXCLUDED from the no-owner count (GitHub issue #83). The count skips an owner
// whose working_tree names another tree (decision
// working-tree-resolution: root sessions exclude working_tree records), but the
// note used to print that row like any owner, so "4 touched file(s) no owner"
// next to "owners seen: <slug>" read as a hook defect. The count itself is
// unchanged: a working_tree that resolves to the project root still owns.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const AT = '2026-10-01T09:00:00.000Z';
const EXCLUDED = 'EXCLUDED: working_tree names another tree';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  // The default floor is 3 unowned files; 1 lets a two-file fixture reach the demand.
  article_demand: { min_unowned_files: 1 },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-owners-seen-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function ownerArticle(store, slug, path, working_tree) {
  return store.create({
    id: randomUUID(), type: 'feature_article', created_at: AT, updated_at: AT, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x', working_tree,
    files: [{ path, role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: AT, event: 'seed' }], live_test_refs: [],
  });
}

/** Touch `paths`, satisfy the capture duty, and run Stop once; returns the deny text. */
function stopWithTouches(dir, store, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: AT }))));
  store.create({
    id: randomUUID(), type: 'decision', created_at: AT, updated_at: AT, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], title: 'learned', statement: 's', alternatives_rejected: [], rationale: 'r',
  });
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

test('owners seen: a working_tree-excluded owner is tagged EXCLUDED, the count is unchanged, and an unowned path reads none', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    ownerArticle(store, 'branch-owner', 'src/a.mjs', 'some-branch');
    const text = stopWithTouches(dir, store, ['src/a.mjs', 'src/b.mjs']);
    assert.match(text, /article demand — 2 touched file\(s\) no owner/, 'the excluded owner does not count: both paths are demanded');
    const line = (p) => text.split(' | ').find((l) => l.includes(`${p} → owners seen:`));
    assert.ok(line('src/a.mjs')?.includes('branch-owner'), 'the note still names the matched row');
    assert.ok(line('src/a.mjs')?.includes(`working_tree=some-branch, ${EXCLUDED}`), 'the matched row is tagged as excluded from the count');
    assert.ok(line('src/b.mjs')?.includes('src/b.mjs → owners seen: none'), 'a path nothing matched reads none');
  } finally {
    cleanup();
  }
});

test('owners seen: an article whose working_tree is the project root counts as an owner (dropped from the demand, no EXCLUDED marker)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    ownerArticle(store, 'root-owner', 'src/a.mjs', dir);
    const text = stopWithTouches(dir, store, ['src/a.mjs', 'src/b.mjs']);
    assert.match(text, /article demand — 1 touched file\(s\) no owner/, 'the self-rooted owner counts: only src/b.mjs is demanded');
    assert.ok(!text.includes(EXCLUDED), 'no EXCLUDED marker for a row the count honours');
    assert.ok(text.includes('src/b.mjs → owners seen: none'), 'the unowned path is the one listed');
  } finally {
    cleanup();
  }
});
