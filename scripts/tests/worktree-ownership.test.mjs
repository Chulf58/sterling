// Ownership and article demand from a linked git worktree OUTSIDE the main checkout
// (board 22f7f45d). The Claude Code hooks run there with input.cwd = the worktree
// and the store at the main checkout, so:
//   - a working_tree that names the project (the main checkout) or a name mapped
//     relative to the project resolves against the STORE root, and still owns the
//     same paths in the session's checkout (H10, H19, settlement);
//   - a worktree's own filesystem (an older checkout missing a file another
//     checkout has) never shrinks an article_missing demand that is shared.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isForeignTree } from '../hooks/lib/working-tree.mjs';
import { ownershipJoin } from '../hooks/lib/session-duties.mjs';
import { mintSettlementReconcile } from '../hooks/lib/settlement.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-11-12T12:00:00.000Z';
const env = { ...process.env, STERLING_CURRENCY_DISABLE: '1' };
delete env.OPENCODE;
delete env.OPENCODE_SESSION_ID;
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  working_trees: { alpha: '../worktrees/alpha' },
};

let SterlingStore, base, main, wt;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-wt-ownership-')));
  main = join(base, 'main');
  mkdirSync(join(main, '.sterling'), { recursive: true });
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(main, '.gitignore'), '.sterling/\n');
  for (const f of ['a', 'm', 'n', 'f']) writeFileSync(join(main, 'src', `${f}.mjs`), `// ${f} v1\n`);
  new SterlingStore(join(main, '.sterling', 'sterling.db')).close();
  git(main, ['init', '-q']);
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'main']);
  wt = join(base, 'worktrees', 'alpha');
  git(main, ['worktree', 'add', '-q', '-b', 'alpha', wt]);
  // Main moves on after the worktree was cut: the worktree has no src/b.mjs.
  writeFileSync(join(main, 'src', 'b.mjs'), '// b\n');
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'b']);
  withStore((store) => {
    article(store, 'owner-m', 'src/m.mjs', main);
    article(store, 'owner-n', 'src/n.mjs', 'alpha');
    article(store, 'owner-f', 'src/f.mjs', 'chore/elsewhere');
  });
});
after(() => rmSync(base, { recursive: true, force: true }));

function withStore(fn) {
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const envelope = (type) => ({ id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] });

function article(store, slug, path, working_tree, baselineOf) {
  return store.create({
    ...envelope('feature_article'),
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    ...(working_tree ? { working_tree } : {}),
    files: [{ path, role: 'impl' }],
    ...(baselineOf ? { file_baselines: { [path]: createHash('sha256').update(baselineOf, 'utf8').digest('hex') } } : {}),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'seed' }], live_test_refs: [],
  });
}

const runHook = (name, input) => spawnSync(process.execPath, [join(repo, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 60_000 });
/** Satisfies the capture duty, so only the article demand is in play at Stop. */
const captureDecision = (at) => withStore((store) => store.create({ ...envelope('decision'), created_at: at, updated_at: at, title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' }));
const systemTodos = (store, reason) => store.query({ types: ['todo'], cap: 200 }).filter((t) => t.source === 'system' && t.system_reason === reason);

test('isForeignTree and ownershipJoin from the worktree: the main checkout and a store-relative mapping own here; another tree does not', () => {
  assert.equal(isForeignTree({ working_tree: main }, wt, CONFIG.working_trees), false, 'a working_tree naming the main checkout names the project');
  assert.equal(isForeignTree({ working_tree: 'alpha' }, wt, CONFIG.working_trees), false, "'alpha' maps relative to the store root, onto this checkout");
  assert.equal(isForeignTree({ working_tree: 'chore/elsewhere' }, wt, CONFIG.working_trees), true);
  assert.equal(isForeignTree({ working_tree: 'alpha' }, main, CONFIG.working_trees), true, 'from the main checkout, alpha is another tree, as before');
  withStore((store) => {
    const join_ = ownershipJoin(store, wt);
    assert.equal(join_.isUnowned('src/m.mjs'), false);
    assert.equal(join_.isUnowned('src/n.mjs'), false);
    assert.equal(join_.isUnowned('src/f.mjs'), true);
  });
});

test('settlement from the worktree mints reconcile debt for an article whose working_tree names the main checkout', () => {
  withStore((store) => {
    const owner = article(store, 'owner-a', 'src/a.mjs', main, '// a v1\n');
    writeFileSync(join(wt, 'src', 'a.mjs'), '// a v2 in the worktree\n');
    mintSettlementReconcile(store, wt, ['src/a.mjs'], NOW);
    const items = systemTodos(store, 'reconcile_needed').filter((t) => t.feature_link === owner.id);
    assert.equal(items.length, 1, 'the drift in the worktree is owed against the owning article');
  });
});

test('bundled H19 from the worktree delivers the main-named owner and raises no FRONTIER SIGNAL', () => {
  const r = runHook('h19-knowledge-delivery.mjs', { session_id: 's-h19', cwd: join(wt, 'src'), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(wt, 'src', 'm.mjs') } });
  assert.equal(r.status, 0, r.stderr);
  const pending = join(wt, '.sterling', 'transient', 'delivery', 'pending.json');
  const delivered = r.stdout + (existsSync(pending) ? readFileSync(pending, 'utf8') : '');
  assert.doesNotMatch(delivered, /FRONTIER SIGNAL/);
  assert.match(delivered, /owner-m/, 'the owning article reaches the worktree session');
});

test('bundled H10 from the worktree demands no article for a path a main-named article owns', () => {
  const transient = join(wt, '.sterling', 'transient');
  rmSync(transient, { recursive: true, force: true });
  mkdirSync(transient, { recursive: true });
  // New files (not in HEAD), so one unowned path is enough to raise the demand.
  withStore((store) => {
    article(store, 'owner-m4', 'src/m4.mjs', main);
    article(store, 'owner-f4', 'src/f4.mjs', 'chore/elsewhere');
  });
  writeFileSync(join(wt, 'src', 'm4.mjs'), '// m4 new in the worktree\n');
  writeFileSync(join(wt, 'src', 'f4.mjs'), '// f4 new in the worktree\n');
  const at = new Date().toISOString();
  writeFileSync(join(transient, 'touches.json'), JSON.stringify([{ path: 'src/m4.mjs', at }, { path: 'src/f4.mjs', at }]));
  captureDecision(at);
  const stop = () => runHook('h10-direct-capture.mjs', { session_id: 's-h10', cwd: wt, hook_event_name: 'Stop', stop_hook_active: false });
  const first = stop();
  const second = stop();
  assert.equal(second.status, 0, `${first.stderr}\n${second.stderr}`);
  withStore((store) => {
    const keys = systemTodos(store, 'article_missing').flatMap((t) => t.file_keys ?? []);
    assert.ok(keys.includes('src/f4.mjs'), `control: a path only another tree owns is demanded (${JSON.stringify(keys)})`);
    assert.equal(keys.includes('src/m4.mjs'), false, 'no duplicate-article demand for the main-named owner');
  });
});

test('bundled H10 in an older worktree never shrinks a shared article_missing demand to what that checkout has on disk', () => {
  const item = withStore((store) =>
    store.create({ ...envelope('todo'), text: 'article_missing fixture', source: 'system', system_reason: 'article_missing', file_keys: ['src/a2.mjs', 'src/b.mjs'], priority: 'normal', lifecycle: 'live', freshness: 'fresh', version: 1 })
  );
  assert.equal(existsSync(join(wt, 'src', 'b.mjs')), false, 'the worktree predates src/b.mjs');
  const transient = join(wt, '.sterling', 'transient');
  rmSync(transient, { recursive: true, force: true });
  mkdirSync(transient, { recursive: true });
  writeFileSync(join(wt, 'src', 'a2.mjs'), '// a2 in the worktree\n');
  const at = new Date().toISOString();
  writeFileSync(join(transient, 'touches.json'), JSON.stringify([{ path: 'src/a2.mjs', at }]));
  captureDecision(at);
  const stop = () => runHook('h10-direct-capture.mjs', { session_id: 's-h10b', cwd: wt, hook_event_name: 'Stop', stop_hook_active: false });
  stop();
  stop();
  withStore((store) => {
    const keys = [...new Set(systemTodos(store, 'article_missing').flatMap((t) => t.file_keys ?? []))].sort();
    assert.ok(keys.includes('src/b.mjs'), `src/b.mjs is still owed (open demands name ${JSON.stringify(keys)}; fixture item ${item.id})`);
    assert.ok(keys.includes('src/a2.mjs'));
  });
  assert.equal(existsSync(join(wt, '.sterling', 'sterling.db')), false);
  assert.equal(readFileSync(join(main, 'src', 'b.mjs'), 'utf8'), '// b\n');
});
