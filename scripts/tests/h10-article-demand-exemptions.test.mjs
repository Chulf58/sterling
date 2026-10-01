// H10 article demand: exempt paths (board 3d3c9d81, KS dashboards gap 6).
//
// The capture duty already skips config.generated_projections (release
// mechanics), but the article demand did not, so a consumer project was asked
// to write an owning article for architecture.md. And a path carried on an open
// article_missing item survived after article_demand.ignore_globs came to cover
// it, because the carried-key heal never re-applied the globs. Both arms below
// also prove the fixture reaches the demand (the CONTROL halves), so a green
// run cannot come from a demand that never fired.
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

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

const writeConfig = (dir, extra = {}) => writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...BASE_CONFIG, ...extra }));

function makeProject(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-demand-exempt-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, extra);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function stop(dir) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function touch(dir, paths, at) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function capture(store, at) {
  return store.create({
    id: randomUUID(), type: 'decision', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], title: 'learned', statement: 's', alternatives_rejected: [], rationale: 'r',
  });
}

/** One session: touch, satisfy the capture duty, Stop until released. */
function encounter(dir, store, paths, at) {
  touch(dir, paths, at);
  capture(store, at);
  const first = stop(dir);
  assert.ok(first.code === 0 || first.code === 2, `encounter @${at}: release or soft-block, never crash (code ${first.code}): ${first.stderr}`);
  const last = first.code === 2 ? stop(dir) : first;
  assert.equal(last.code, 0, `encounter @${at}: the session releases: ${last.stderr}`);
}

const demandedPaths = (store) =>
  [...new Set(store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'article_missing').flatMap((t) => t.file_keys ?? []))].sort();

const SRC = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'];

test('generated projection: a path in config.generated_projections never reaches article_missing (CONTROL: without the config entry it is demanded)', () => {
  const control = makeProject();
  try {
    encounter(control.dir, control.store, [...SRC, 'architecture.md'], '2026-10-01T09:00:00.000Z');
    assert.ok(demandedPaths(control.store).includes('architecture.md'), 'CONTROL: the fixture reaches the demand for architecture.md');
  } finally {
    control.cleanup();
  }
  const { dir, store, cleanup } = makeProject({ generated_projections: ['architecture.md', 'rulings.md'] });
  try {
    encounter(dir, store, [...SRC, 'architecture.md', 'rulings.md'], '2026-10-01T09:00:00.000Z');
    assert.deepEqual(demandedPaths(store), SRC, 'a generated projection is regenerated from the store; it can never own an article and must not be demanded');
  } finally {
    cleanup();
  }
});

test('carried item: a carried path that an ignore glob or a generated_projections entry now covers is dropped from the open item', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'scenes/x.gd.uid', 'docs/arch.md'], '2026-10-01T09:00:00.000Z');
    assert.deepEqual(demandedPaths(store), ['docs/arch.md', 'scenes/x.gd.uid', 'src/a.mjs', 'src/b.mjs'], 'baseline: both paths are demanded while no policy covers them');

    writeConfig(dir, { article_demand: { ignore_globs: ['**/*.uid'] }, generated_projections: ['docs/arch.md'] });
    // Neither covered path is touched again: they can leave only as carried keys.
    encounter(dir, store, SRC, '2026-10-01T10:00:00.000Z');
    assert.deepEqual(demandedPaths(store), SRC, 'a path the policy now exempts is undischargeable demand and must leave the carried item');
  } finally {
    cleanup();
  }
});
