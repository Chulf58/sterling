// Checkout evidence on reconcile debt (decision
// maintenance-reconciliation-retains-checkout-evidence-and-use). Real git
// repositories with a linked worktree, a temporary store and the real worker
// policy (WorkerGuard.authorize + runChecked, the code guardWorkerTools runs).
// Debt is minted the way settlement mints it (mintSettlementReconcile at the
// checkout's root). Before this change the worker paid worktree B's debt from
// the main checkout through both maintenance_remove and knowledge_update with
// resolves (scratch reproducer, rerun by the conductor 2026-11-02); the
// [RED] tests below pin that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { WorkerGuard } from '../worker-policy.js';
import { parseConfig } from '@sterling/schemas';
import { itemProvenance, observePaths, proveObservation, headCommit } from '../../../../scripts/hooks/lib/reconcile-origins.mjs';

type Loose = Record<string, unknown>;
const NOW = '2026-11-02T12:00:00.000Z';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const settlement = (await import(pathToFileURL(join(REPO, 'scripts/hooks/lib/settlement.mjs')).href)) as {
  mintSettlementReconcile: (store: unknown, root: string, paths: string[], now: string) => { article_id: string; paths: string[] }[];
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-origins-')));
  const main = join(base, 'main');
  mkdirSync(join(main, '.sterling'), { recursive: true });
  writeFileSync(join(main, '.sterling', 'config.json'), '{}');
  writeFileSync(join(main, '.gitignore'), '.sterling/\n');
  writeFileSync(join(main, 'f.txt'), 'A\n');
  writeFileSync(join(main, 'g.txt'), 'G\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'A');
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: main });
  const mk = (slug: string, path: string) =>
    (
      tools.knowledgeCreate('feature_article', {
        slug, title: slug, what_it_does: 'x', intended_behavior: 'x', files: [{ path, role: 'impl' }],
        current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] },
        state: 'active', version: 1, history: [{ date: NOW, event: 'seed' }], live_test_refs: [],
      } as never) as unknown as { record: Loose }
    ).record as Loose & { id: string };
  const article = mk('feat-f', 'f.txt');
  const other = mk('feat-g', 'g.txt');
  const wt = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  git(wt, 'config', 'user.email', 't@t.t');
  git(wt, 'config', 'user.name', 't');
  const policyPath = join(base, 'eligible.json');
  const token = 'tok-1';
  const writePolicy = (items: { id: string; lane: string; target_id: string | null; file_keys: string[] }[]) =>
    writeFileSync(policyPath, JSON.stringify({ token, head: git(main, 'rev-parse', 'HEAD'), host: 'claude', items: [], policy_version: 1, run_id: 'run-1', policy_items: items }));
  const guard = new WorkerGuard({ path: policyPath, token }, store as never, tools);
  const worker = (tool: string, input: Loose, run: () => unknown) => {
    const allowed = guard.authorize(tool, input);
    assert.ok(allowed, `${tool} is a worker write`);
    return guard.runChecked(tool, input, allowed, run);
  };
  const reconcileItems = (articleId = article.id) =>
    (store.query({ types: ['todo'], cap: 1000 }) as unknown as (Loose & { id: string; version?: number; observations?: Loose[]; file_keys?: string[] })[]).filter(
      (t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link === articleId
    );
  const mint = (root: string, paths = ['f.txt'], articleId = article.id) => {
    settlement.mintSettlementReconcile(store, root, paths, NOW);
    const [item] = reconcileItems(articleId);
    assert.ok(item, 'settlement minted a reconcile_needed item');
    writePolicy([{ id: item.id, lane: 'reconcile_needed', target_id: articleId, file_keys: item.file_keys ?? [] }]);
    return item;
  };
  const baseline = () => (store.get(article.id) as unknown as { file_baselines: Record<string, string> }).file_baselines['f.txt'];
  const cleanup = () => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  };
  return { base, main, wt, store, tools, article, other, worker, mint, reconcileItems, writePolicy, baseline, cleanup, policyPath, token, mk };
}

const refusedWith = (fn: () => unknown, rule: RegExp) => assert.throws(fn, (e: Error) => rule.test(e.message), `refused with ${rule}`);

for (const committed of [false, true]) {
  test(`[RED] main worker cannot attest-close worktree B's ${committed ? 'committed, unmerged' : 'dirty'} debt; item and baseline stay`, () => {
    const f = fixture();
    try {
      writeFileSync(join(f.wt, 'f.txt'), 'B\n');
      if (committed) git(f.wt, 'commit', '-qam', 'B');
      const item = f.mint(f.wt);
      assert.equal((item.observations as { checkout: { kind: string } }[])[0].checkout.kind, 'checkout', 'B is recorded as another checkout');
      // Committed but unmerged waits for integration; an uncommitted state of
      // another checkout is ambiguous and is the conductor's.
      refusedWith(() => f.worker('maintenance_remove', { id: item.id }, () => f.tools.maintenanceRemove(item.id)), committed ? /provenance_not_integrated/ : /provenance_needs_conductor/);
      assert.equal(f.reconcileItems().length, 1, 'the debt is still owed');
      assert.equal(f.baseline(), sha('A\n'), 'nothing re-baselined');
    } finally {
      f.cleanup();
    }
  });

  test(`[RED] main worker cannot pay B's ${committed ? 'committed' : 'dirty'} debt with knowledge_update, with or without resolves`, () => {
    const f = fixture();
    try {
      writeFileSync(join(f.wt, 'f.txt'), 'B\n');
      if (committed) git(f.wt, 'commit', '-qam', 'B');
      const item = f.mint(f.wt);
      const v = (f.store.get(f.article.id) as unknown as { version: number }).version;
      for (const resolves of [[item.id], []]) {
        const input = { id: f.article.id, body: { what_it_does: 'f prints A' }, expected_version: v, ...(resolves.length ? { resolves } : {}) };
        refusedWith(
          () => f.worker('knowledge_update', input, () => f.tools.knowledgeUpdate(f.article.id, { what_it_does: 'f prints A' }, resolves)),
          committed ? /provenance_not_integrated/ : /provenance_needs_conductor/
        );
      }
      assert.equal(f.reconcileItems().length, 1);
      assert.equal((f.store.get(f.article.id) as unknown as { what_it_does: string }).what_it_does, 'x', 'no wrong-checkout prose landed');
    } finally {
      f.cleanup();
    }
  });
}

test('a normal merge of B integrates the evidence: the worker attests the close; an unrelated item drains meanwhile', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    git(f.wt, 'commit', '-qam', 'B');
    const item = f.mint(f.wt);
    writeFileSync(join(f.main, 'g.txt'), 'G2\n');
    git(f.main, 'commit', '-qam', 'G2');
    const other = f.mint(f.main, ['g.txt'], f.other.id);
    f.writePolicy([
      { id: item.id, lane: 'reconcile_needed', target_id: f.article.id, file_keys: ['f.txt'] },
      { id: other.id, lane: 'reconcile_needed', target_id: f.other.id, file_keys: ['g.txt'] },
    ]);
    assert.equal((other.observations as { checkout: { kind: string } }[])[0].checkout.kind, 'store');
    f.worker('maintenance_remove', { id: other.id }, () => f.tools.maintenanceRemove(other.id));
    assert.equal(f.reconcileItems(f.other.id).length, 0, 'the store checkout debt drained');
    refusedWith(() => f.worker('maintenance_remove', { id: item.id }, () => f.tools.maintenanceRemove(item.id)), /provenance_not_integrated/);
    git(f.main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    f.worker('maintenance_remove', { id: item.id }, () => f.tools.maintenanceRemove(item.id));
    assert.equal(f.reconcileItems().length, 0);
    assert.equal(f.baseline(), sha('B\n'), 'attested against the merged committed bytes');
  } finally {
    f.cleanup();
  }
});

test('[RED] a newly observed DIRTY state is not paid by an older commit that held it: historical B, reverted target, checkout reused at H', () => {
  const f = fixture();
  try {
    const H = headCommit(f.main)!;
    writeFileSync(join(f.main, 'f.txt'), 'B\n');
    git(f.main, 'commit', '-qam', 'historical B');
    writeFileSync(join(f.main, 'f.txt'), 'A\n');
    git(f.main, 'commit', '-qam', 'revert to A');
    const T = headCommit(f.main)!;
    git(f.wt, 'reset', '-q', '--hard', H);
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    const fresh = observePaths(f.wt, ['f.txt'], f.main)!.observations[0];
    assert.equal(fresh.commit, H, 'observed dirty on the reused checkout at H');
    const r = proveObservation(f.main, T, fresh);
    assert.equal(r.ok, false, 'the historical commit that held B descends from H and is in T, and still proves nothing about this edit');
    assert.equal((r as { hold?: string }).hold, 'conductor', 'another checkout\'s unmatched uncommitted state is ambiguous: the conductor\'s, not an endless wait');
  } finally {
    f.cleanup();
  }
});

test('proofs under the final contract: exact-content squash and committed-ancestor pay; a dirty observation pays only while T holds exactly its state', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    const dirty = observePaths(f.wt, ['f.txt'], f.main)!.observations[0];
    assert.equal(proveObservation(f.main, headCommit(f.main)!, dirty).ok, false, 'nothing landed yet');
    git(f.wt, 'commit', '-qam', 'B');
    const committed = observePaths(f.wt, ['f.txt'], f.main)!.observations[0];
    git(f.main, 'merge', '-q', '--squash', 'feat');
    git(f.main, 'commit', '-qm', 'squash');
    const T1 = headCommit(f.main)!;
    assert.deepEqual(proveObservation(f.main, T1, committed), { ok: true, via: 'target_holds_observed_state' }, 'squash with exact content');
    assert.deepEqual(proveObservation(f.main, T1, dirty), { ok: true, via: 'target_holds_observed_state' }, 'the dirty edit, later committed and squashed, while T holds it');
    writeFileSync(join(f.main, 'f.txt'), 'C\n');
    git(f.main, 'commit', '-qam', 'C after squash');
    const T2 = headCommit(f.main)!;
    // Was a "waits forever" limitation; per the design ruling an unmatched
    // dirty observation from another checkout is handed to the conductor.
    const moved = proveObservation(f.main, T2, dirty);
    assert.equal(moved.ok, false, 'once T moves past, the dirty observation is not provable');
    assert.equal((moved as { hold?: string }).hold, 'conductor', 'and it is the conductor\'s, never a silent wait');
    assert.equal(proveObservation(f.main, T2, committed).ok, false, 'B\'s own commit is not in T and T no longer holds its state');
    git(f.main, 'merge', '-q', '-X', 'ours', '-m', 'merge feat', 'feat');
    assert.deepEqual(proveObservation(f.main, headCommit(f.main)!, committed), { ok: true, via: 'committed_ancestor' }, 'a normal merge puts B\'s commit in T\'s history');
  } finally {
    f.cleanup();
  }
});

test('proofs: revert, deletion, unreadable, missing commit and a recreated checkout with the same name never pay', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    const reverted = observePaths(f.wt, ['f.txt'], f.main)!.observations[0];
    writeFileSync(join(f.wt, 'f.txt'), 'A\n');
    git(f.wt, 'commit', '-q', '--allow-empty', '-m', 'nothing');
    git(f.main, 'merge', '-q', '-m', 'merge feat', 'feat');
    const T = headCommit(f.main)!;
    assert.equal(proveObservation(f.main, T, reverted).ok, false, 'B reverted before committing: its observed state never landed');
    unlinkSync(join(f.wt, 'f.txt'));
    const deleted = observePaths(f.wt, ['f.txt'], f.main)!.observations[0];
    assert.deepEqual(deleted.state, { kind: 'absent' });
    assert.equal(proveObservation(f.main, T, deleted).ok, false, 'an uncommitted deletion is not in T');
    git(f.main, 'worktree', 'remove', '--force', f.wt);
    git(f.main, 'worktree', 'add', '-q', '-B', 'feat', f.wt);
    assert.equal(proveObservation(f.main, T, reverted).ok, false, 'a checkout gone and recreated under the same name and branch proves nothing');
    const unreadable = { ...reverted, state: { kind: 'unreadable' as const } };
    assert.equal((proveObservation(f.main, T, unreadable) as { hold?: string }).hold, 'conductor');
    const missing = { ...reverted, commit: 'f'.repeat(40) };
    assert.equal((proveObservation(f.main, T, missing) as { hold?: string }).hold, 'conductor');
  } finally {
    f.cleanup();
  }
});

test('legacy debt stays unknown when new evidence folds; evidence folds monotonically and a provenance-only change bumps the version', () => {
  const f = fixture();
  try {
    f.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-f' — legacy", file_keys: ['f.txt'], feature_link: f.article.id });
    const [legacy] = f.reconcileItems();
    assert.equal(legacy.observations, undefined);
    writeFileSync(join(f.main, 'f.txt'), 'M\n');
    git(f.main, 'commit', '-qam', 'M');
    const folded = f.mint(f.main);
    assert.equal(folded.id, legacy.id, 'one item per article');
    const kinds = (folded.observations ?? []).map((o) => (o.state as { kind: string }).kind).sort();
    assert.deepEqual(kinds, ['file', 'unknown'], 'the legacy gap is explicit and survives the fold');
    assert.ok((folded.version ?? 0) > (legacy.version ?? 0), 'a provenance-only change bumps the version');
    const p = itemProvenance(folded as never, f.main, headCommit(f.main)!);
    assert.equal(p.conductor, true, 'unknown evidence is the conductor\'s');
    refusedWith(() => f.worker('maintenance_remove', { id: folded.id }, () => f.tools.maintenanceRemove(folded.id)), /provenance_needs_conductor/);
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    f.mint(f.wt);
    f.mint(f.wt);
    const twice = f.reconcileItems()[0];
    assert.equal((twice.observations ?? []).length, 3, 'B is added once; a repeat observation dedups; nothing is dropped');
    writeFileSync(join(f.main, 'f.txt'), 'M2\n');
    git(f.main, 'commit', '-qam', 'M2');
    const replaced = f.mint(f.main);
    const left = (replaced.observations ?? []).map((o) => `${(o.checkout as { kind: string }).kind}:${(o.state as { kind: string }).kind}`).sort();
    assert.deepEqual(left, ['checkout:file', 'store:file', 'unknown:unknown'], 'the store checkout replaces only its own overwritten state; the legacy unknown and B survive');
  } finally {
    f.cleanup();
  }
});

test('the store checkout supersedes only its own observations it re-read; B\'s are never superseded', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.main, 'f.txt'), 'M1\n');
    f.mint(f.main);
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    f.mint(f.wt);
    writeFileSync(join(f.main, 'f.txt'), 'M2\n');
    git(f.main, 'commit', '-qam', 'M2');
    const item = f.mint(f.main);
    const states = (item.observations ?? []).map((o) => `${(o.checkout as { kind: string }).kind}`).sort();
    assert.deepEqual(states, ['checkout', 'store'], 'the overwritten dirty M1 is replaced by M2; B stays');
    writeFileSync(join(f.main, 'f.txt'), 'A\n');
    git(f.main, 'commit', '-qam', 'back to A');
    const back = f.mint(f.main);
    assert.equal((back.observations ?? []).filter((o) => (o.checkout as { kind: string }).kind === 'store').length, 1, 'a path no longer drifting is re-observed, not left on the overwritten state');
  } finally {
    f.cleanup();
  }
});

test('a fold that lands after the proof refuses the write under the lock; nothing is written', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.main, 'f.txt'), 'M\n');
    git(f.main, 'commit', '-qam', 'M');
    const item = f.mint(f.main);
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    refusedWith(
      () =>
        f.worker('maintenance_remove', { id: item.id }, () => {
          f.mint(f.wt);
          return f.tools.maintenanceRemove(item.id);
        }),
      /version conflict/
    );
    assert.equal(f.reconcileItems().length, 1);
    assert.equal(f.baseline(), sha('A\n'));
    const v0 = (f.store.get(f.article.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', lane: 'reconcile_needed', target_id: f.article.id, file_keys: ['f.txt'] }]);
    const fresh = f.reconcileItems()[0];
    assert.equal(itemProvenance(fresh as never, f.main, headCommit(f.main)!).payable, false, 'B is not integrated');
    git(f.wt, 'checkout', '-q', '--', 'f.txt');
    const two = { id: f.article.id, body: { what_it_does: 'one' }, expected_version: v0 };
    refusedWith(() => f.worker('knowledge_update', two, () => 'unreached'), /provenance_needs_conductor/);
    const v = (f.store.get(f.other.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a', lane: 'reconcile_needed', target_id: f.other.id, file_keys: ['g.txt'] }]);
    refusedWith(
      () =>
        f.worker('knowledge_update', { id: f.other.id, body: { what_it_does: 'y' }, expected_version: v }, () => {
          writeFileSync(join(f.wt, 'g.txt'), 'GB\n');
          f.mint(f.wt, ['g.txt'], f.other.id);
          return f.tools.knowledgeUpdate(f.other.id, { what_it_does: 'y' });
        }),
      /version conflict/
    );
  } finally {
    f.cleanup();
  }
});

test('mirrored: a session in worktree B baselines and attests against the store checkout, never its own unmerged bytes', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    git(f.wt, 'commit', '-qam', 'B');
    const item = f.mint(f.wt);
    const inB = new SterlingTools({ store: f.store, now: () => NOW, repoRoot: f.main, checkoutRoot: f.wt });
    inB.maintenanceRemove(item.id);
    assert.equal(f.baseline(), sha('A\n'), 'the conductor may resolve the debt explicitly, but the shared baseline is attested from the store checkout, not B');
  } finally {
    f.cleanup();
  }
});

test('no public write can forge or erase checkout evidence', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    const item = f.mint(f.wt);
    const forged = [{ path: 'f.txt', checkout: { kind: 'store' }, commit: 'a'.repeat(40), state: { kind: 'absent' } }];
    assert.throws(() => f.tools.knowledgeUpdate(item.id, { observations: forged }));
    assert.throws(() => f.tools.boardUpdate(item.id, { observations: forged } as never));
    assert.throws(
      () => f.tools.knowledgeCreate('todo', { text: 'forged', source: 'system', system_reason: 'reconcile_needed', file_keys: ['f.txt'], feature_link: f.article.id, observations: forged } as never),
      /'observations' is SERVER-OWNED/
    );
    assert.deepEqual(f.reconcileItems()[0].observations, item.observations);
  } finally {
    f.cleanup();
  }
});

test('the fence covers one write: a second write to the fenced record in the same worker call is refused', () => {
  const f = fixture();
  try {
    const v = (f.store.get(f.other.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a', lane: 'reconcile_needed', target_id: f.other.id, file_keys: ['g.txt'] }]);
    refusedWith(
      () =>
        f.worker('knowledge_update', { id: f.other.id, body: { what_it_does: 'one' }, expected_version: v }, () => {
          f.tools.knowledgeUpdate(f.other.id, { what_it_does: 'one' });
          return f.tools.knowledgeUpdate(f.other.id, { what_it_does: 'two' });
        }),
      /write fence/
    );
    assert.equal((f.store.get(f.other.id) as unknown as { what_it_does: string }).what_it_does, 'one', 'only the proven write landed');
  } finally {
    f.cleanup();
  }
});

test('an article_missing join needs the joined path committed and unmodified in the store checkout', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'h.txt'), 'H\n');
    git(f.wt, 'add', 'h.txt');
    git(f.wt, 'commit', '-qm', 'h only in B');
    const { record } = f.tools.maintenanceEnqueue({ reason: 'article_missing', text: 'h.txt has no owning article', file_keys: ['h.txt'] }) as unknown as { record: { id: string } };
    f.writePolicy([{ id: record.id, lane: 'article_missing', target_id: null, file_keys: ['h.txt'] }]);
    const input = { id: f.article.id, field: 'files', entries: [{ path: 'h.txt', role: 'x' }], resolves: [record.id] };
    refusedWith(() => f.worker('knowledge_append', input, () => 'unreached'), /provenance_not_integrated/);
    writeFileSync(join(f.main, 'h.txt'), 'H\n');
    refusedWith(() => f.worker('knowledge_append', input, () => 'unreached'), /provenance_not_integrated/);
    assert.ok(f.store.get(record.id), 'the debt stays open');
  } finally {
    f.cleanup();
  }
});

// ---- one live owner and one immutable snapshot from proof to write (task-end review) ----
const ARTICLE_BODY = (slug: string, path: string, extra: Loose = {}) => ({
  ...extra,
  slug, title: slug, what_it_does: 'x', intended_behavior: 'x', files: [{ path, role: 'impl' }],
  current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] },
  state: 'active', version: 1, history: [{ date: NOW, event: 'seed' }], live_test_refs: [],
});
const repo = (dir: string, files: Record<string, string>) => {
  mkdirSync(dir, { recursive: true });
  for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
};
const workerWith = (f: ReturnType<typeof fixture>, tools: SterlingTools) => {
  const guard = new WorkerGuard({ path: f.policyPath, token: f.token }, f.store as never, tools);
  return (tool: string, input: Loose, run: () => unknown) => {
    const allowed = guard.authorize(tool, input);
    assert.ok(allowed);
    return guard.runChecked(tool, input, allowed, run);
  };
};
const baselineOf = (f: ReturnType<typeof fixture>, id: string, path: string) => (f.store.get(id) as unknown as { file_baselines?: Record<string, string> }).file_baselines?.[path];

test('[RED] a stored link to a RETIRED owner is proven against the live successor, never against the retired owner\'s tree', () => {
  const f = fixture();
  try {
    const tools = new SterlingTools({ store: f.store, now: () => NOW, repoRoot: f.main, config: parseConfig({ working_trees: { wt: f.wt } }) });
    const old = (tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-old', 'f.txt', { working_tree: 'wt' }) as never) as unknown as { record: { id: string } }).record;
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    git(f.wt, 'commit', '-qam', 'B');
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-old' — f.txt", file_keys: ['f.txt'], feature_link: old.id }, observePaths(f.wt, ['f.txt'], f.main)!.observations);
    const item = f.reconcileItems(old.id)[0];
    const live = (tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-new', 'f.txt') as never) as unknown as { record: { id: string } }).record;
    tools.knowledgeRetire(old.id, live.id);
    const liveBaseline = baselineOf(f, live.id, 'f.txt');
    const liveVersion = (f.store.get(live.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: item.id, lane: 'reconcile_needed', target_id: old.id, file_keys: ['f.txt'] }]);
    refusedWith(() => workerWith(f, tools)('maintenance_remove', { id: item.id }, () => tools.maintenanceRemove(item.id)), /provenance_not_integrated/);
    assert.ok(f.store.get(item.id), 'B\'s debt is still owed');
    assert.equal(baselineOf(f, live.id, 'f.txt'), liveBaseline, 'the live owner was not re-baselined');
    assert.equal((f.store.get(live.id) as unknown as { version: number }).version, liveVersion);
  } finally {
    f.cleanup();
  }
});

test('[RED] HEAD reset after the proof: the close refuses and writes nothing', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    git(f.wt, 'commit', '-qam', 'B');
    const item = f.mint(f.wt);
    git(f.main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    const v = (f.store.get(f.article.id) as unknown as { version: number }).version;
    refusedWith(
      () =>
        f.worker('maintenance_remove', { id: item.id }, () => {
          git(f.main, 'reset', '-q', '--hard', 'HEAD~1');
          return f.tools.maintenanceRemove(item.id);
        }),
      /cannot be closed|version conflict/
    );
    assert.ok(f.store.get(item.id), 'the debt is still owed');
    assert.equal(f.baseline(), sha('A\n'), 'no baseline was stamped');
    assert.equal((f.store.get(f.article.id) as unknown as { version: number }).version, v);
  } finally {
    f.cleanup();
  }
});

test('[RED] a working file changed after the proof: a resolving write stores the SNAPSHOT\'s baseline, so the new bytes stay owed; a file already modified at preparation refuses', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, 'f.txt'), 'B\n');
    git(f.wt, 'commit', '-qam', 'B');
    const item = f.mint(f.wt);
    git(f.main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    const v = (f.store.get(f.article.id) as unknown as { version: number }).version;
    // Modified BEFORE the proof: preparation refuses, nothing is written.
    writeFileSync(join(f.main, 'f.txt'), 'C\n');
    refusedWith(() => f.worker('knowledge_update', { id: f.article.id, body: { what_it_does: 'x2' }, expected_version: v, resolves: [item.id] }, () => 'unreached'), /provenance_not_integrated/);
    assert.ok(f.store.get(item.id));
    assert.equal(f.baseline(), sha('A\n'));
    writeFileSync(join(f.main, 'f.txt'), 'B\n');
    // Modified AFTER the proof (inside the call): the prepared baseline is stamped.
    f.worker('knowledge_update', { id: f.article.id, body: { what_it_does: 'f prints B' }, expected_version: v, resolves: [item.id] }, () => {
      writeFileSync(join(f.main, 'f.txt'), 'C\n');
      return f.tools.knowledgeUpdate(f.article.id, { what_it_does: 'f prints B' }, [item.id]);
    });
    assert.equal(f.store.get(item.id), undefined, 'B\'s debt is paid');
    assert.equal(f.baseline(), sha('B\n'), 'the baseline is B as committed in T, not the working file C');
    assert.equal((f.store.get(f.article.id) as unknown as { what_it_does: string }).what_it_does, 'f prints B');
  } finally {
    f.cleanup();
  }
});

test('[RED] the owner\'s working_tree mapping changed after the proof: the fence refuses and writes nothing', () => {
  const f = fixture();
  try {
    const s1 = join(f.base, 's1');
    const s2 = join(f.base, 's2');
    repo(s1, { 's.txt': 'S\n' });
    repo(s2, { 's.txt': 'OTHER\n' });
    // The mapping is configured ON DISK (as config_set writes it) and cached by
    // the server at start; the disk changes mid-call, the cache does not.
    writeFileSync(join(f.main, '.sterling', 'config.json'), JSON.stringify({ working_trees: { side: s1 } }));
    const config = parseConfig({ working_trees: { side: s1 } });
    const tools = new SterlingTools({ store: f.store, now: () => NOW, repoRoot: f.main, config });
    const art = (tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-s', 's.txt', { working_tree: 'side' }) as never) as unknown as { record: { id: string } }).record;
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-s' — s.txt", file_keys: ['s.txt'], feature_link: art.id }, observePaths(s1, ['s.txt'], f.main)!.observations);
    const item = f.reconcileItems(art.id)[0];
    const before = baselineOf(f, art.id, 's.txt');
    f.writePolicy([{ id: item.id, lane: 'reconcile_needed', target_id: art.id, file_keys: ['s.txt'] }]);
    refusedWith(
      () =>
        workerWith(f, tools)('maintenance_remove', { id: item.id }, () => {
          writeFileSync(join(f.main, '.sterling', 'config.json'), JSON.stringify({ working_trees: { side: s2 } }));
          return tools.maintenanceRemove(item.id);
        }),
      /version conflict|cannot be closed/
    );
    assert.ok(f.store.get(item.id));
    assert.equal(baselineOf(f, art.id, 's.txt'), before);
  } finally {
    f.cleanup();
  }
});

test('proofs: the exact target state pays even when the origin commit is gone; with the commit gone and the state different it is the conductor\'s', () => {
  const f = fixture();
  try {
    const T = headCommit(f.main)!;
    const blob = git(f.main, 'rev-parse', `${T}:f.txt`);
    const gone = 'f'.repeat(40);
    const same = { path: 'f.txt', checkout: { kind: 'checkout' as const, worktree: 'wt' }, commit: gone, state: { kind: 'file' as const, mode: '100644' as const, blob } };
    assert.deepEqual(proveObservation(f.main, T, same), { ok: true, via: 'target_holds_observed_state' });
    const other = { ...same, state: { ...same.state, blob: git(f.main, 'hash-object', '--stdin', '--no-filters') } };
    const r = proveObservation(f.main, T, other);
    assert.equal(r.ok, false);
    assert.equal((r as { hold?: string }).hold, 'conductor');
  } finally {
    f.cleanup();
  }
});

test('schema: malformed checkout evidence is refused by the store, which derives its type from the one todo schema', () => {
  const f = fixture();
  try {
    const bad = { id: '6c5b4a39-2817-4f06-9e5d-4c3b2a190807', type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: 'x', source: 'system', system_reason: 'reconcile_needed', file_keys: ['f.txt'], feature_link: f.article.id, observations: [{ path: 'f.txt', checkout: { kind: 'store' }, commit: 'a'.repeat(40), state: { kind: 'file', mode: '644', blob: 'b'.repeat(40) } }] };
    assert.throws(() => f.store.enqueueSystemTodo(bad, { operation_id: '7d6c5b4a-3928-4f17-8e6d-5c4b3a291808' }));
    assert.equal(f.reconcileItems().length, 0);
  } finally {
    f.cleanup();
  }
});

test('[RED] debt completeness: an item linked through a retired predecessor, and one whose link resolves nowhere but names an owned path, both block a worker write on the live owner', () => {
  const f = fixture();
  try {
    const old = (f.tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-h1', 'h.txt') as never) as unknown as { record: { id: string } }).record;
    f.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-h1' — h.txt", file_keys: ['h.txt'], feature_link: old.id });
    const live = (f.tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-h2', 'h.txt') as never) as unknown as { record: { id: string } }).record;
    f.tools.knowledgeRetire(old.id, live.id);
    const v = (f.store.get(live.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', lane: 'reconcile_needed', target_id: live.id, file_keys: ['h.txt'] }]);
    refusedWith(() => f.worker('knowledge_update', { id: live.id, body: { what_it_does: 'y' }, expected_version: v }, () => f.tools.knowledgeUpdate(live.id, { what_it_does: 'y' })), /provenance_needs_conductor/);
    assert.equal((f.store.get(live.id) as unknown as { version: number }).version, v, 'the predecessor\'s legacy debt blocks the write');
    const orphan = (f.store.query({ types: ['todo'], cap: 100 }) as unknown as { id: string; feature_link?: string }[]).find((t) => t.feature_link === old.id)!;
    f.store.remove(orphan.id, NOW);
    f.store.create(
      { id: '2a3b4c5d-6e7f-4809-9a1b-2c3d4e5f6a7b', type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: 'dangling', source: 'system', system_reason: 'reconcile_needed', file_keys: ['h.txt'], feature_link: '3b4c5d6e-7f80-4a1b-8c2d-3e4f5a6b7c8d' } as never,
      { operation_id: '4c5d6e7f-8091-4b2c-9d3e-4f5a6b7c8d9e' }
    );
    refusedWith(() => f.worker('knowledge_update', { id: live.id, body: { what_it_does: 'y' }, expected_version: v }, () => f.tools.knowledgeUpdate(live.id, { what_it_does: 'y' })), /provenance_needs_conductor/);
    assert.equal((f.store.get(live.id) as unknown as { version: number }).version, v, 'a link that resolves nowhere over an owned path is not dropped');
  } finally {
    f.cleanup();
  }
});

// ---- one known debt lineage: alias -> supersede chain -> live owner ----
const aliasRow = (f: ReturnType<typeof fixture>, historical: string, canonical: string) =>
  (f.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
    .prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historical, canonical, 1, NOW);

test('[RED] canonical lineage: debt linked through a HISTORICAL alias is paid by the worker against the live owner (attested), and the journal of the store records the close', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.main, 'f.txt'), 'M\n');
    git(f.main, 'commit', '-qam', 'M');
    const historical = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
    aliasRow(f, historical, f.article.id);
    f.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-f' — f.txt", file_keys: ['f.txt'], feature_link: historical }, observePaths(f.main, ['f.txt'], f.main)!.observations);
    const item = f.reconcileItems(historical)[0];
    f.writePolicy([{ id: item.id, lane: 'reconcile_needed', target_id: historical, file_keys: ['f.txt'] }]);
    f.worker('maintenance_remove', { id: item.id }, () => f.tools.maintenanceRemove(item.id));
    assert.equal(f.store.get(item.id), undefined, 'the alias-linked debt is closed');
    assert.equal(f.baseline(), sha('M\n'), 'attested on the live owner at the proven commit');
    assert.ok(f.store.drainLogEntry(item.id), 'the drain log records the close');
  } finally {
    f.cleanup();
  }
});

test('[RED] canonical lineage: pruning removes debt linked through a multi-hop retired predecessor, and never debt whose link resolves nowhere', () => {
  const f = fixture();
  try {
    const mkA = (slug: string) => (f.tools.knowledgeCreate('feature_article', ARTICLE_BODY(slug, 'p.txt', { files: [{ path: 'p.txt', role: 'impl' }, { path: 'q.txt', role: 'impl' }] }) as never) as unknown as { record: { id: string } }).record;
    const a1 = mkA('lin-1');
    const a2 = mkA('lin-2');
    const a3 = mkA('lin-3');
    f.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'lin-1' — p.txt", file_keys: ['p.txt'], feature_link: a1.id });
    f.tools.knowledgeRetire(a1.id, a2.id);
    f.tools.knowledgeRetire(a2.id, a3.id);
    const lineage = f.reconcileItems(a1.id)[0];
    const dangling = '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c';
    f.store.create(
      { id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: 'dangling', source: 'system', system_reason: 'reconcile_needed', file_keys: ['p.txt'], feature_link: dangling } as never,
      { operation_id: '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e' }
    );
    f.tools.knowledgeUpdate(a3.id, { files: [{ path: 'q.txt', role: 'impl' }] });
    assert.deepEqual((f.store.get(a3.id) as unknown as { files: { path: string }[] }).files.map((x) => x.path), ['q.txt']);
    assert.equal(f.store.get(lineage.id), undefined, 'the predecessor-linked debt for the dropped path is pruned');
    assert.ok(f.store.drainLogEntry(lineage.id), 'through the normal removal path');
    assert.ok(f.store.get('7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'), 'a link that resolves nowhere is never pruned on a path overlap');
  } finally {
    f.cleanup();
  }
});

test('[RED] a mapping repaired on disk after the server started: the resolving worker write stores the PROVEN snapshot baseline, not the cached routing\'s nothing', () => {
  const f = fixture();
  try {
    const s1 = join(f.base, 's1');
    repo(s1, { 's.txt': 'S\n' });
    // The server started with no mapping for 'side' (cached); the mapping is then repaired on disk.
    const tools = new SterlingTools({ store: f.store, now: () => NOW, repoRoot: f.main, config: parseConfig({}) });
    const art = (tools.knowledgeCreate('feature_article', ARTICLE_BODY('feat-side', 's.txt', { working_tree: 'side' }) as never) as unknown as { record: { id: string } }).record;
    writeFileSync(join(f.main, '.sterling', 'config.json'), JSON.stringify({ working_trees: { side: s1 } }));
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-side' — s.txt", file_keys: ['s.txt'], feature_link: art.id }, observePaths(s1, ['s.txt'], f.main)!.observations);
    const item = f.reconcileItems(art.id)[0];
    const v = (f.store.get(art.id) as unknown as { version: number }).version;
    f.writePolicy([{ id: item.id, lane: 'reconcile_needed', target_id: art.id, file_keys: ['s.txt'] }]);
    workerWith(f, tools)('knowledge_update', { id: art.id, body: { what_it_does: 's prints S' }, expected_version: v, resolves: [item.id] }, () =>
      tools.knowledgeUpdate(art.id, { what_it_does: 's prints S' }, [item.id])
    );
    assert.equal(f.store.get(item.id), undefined, 'the proven debt is paid');
    assert.equal(baselineOf(f, art.id, 's.txt'), sha('S\n'), 'the baseline is the proven snapshot hash, not dropped by the stale cached routing');
  } finally {
    f.cleanup();
  }
});
