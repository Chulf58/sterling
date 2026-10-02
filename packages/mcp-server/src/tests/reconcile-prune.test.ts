// PATH PRUNING FOR reconcile_needed (board 7e779e1f).
//
// Transferring a file between owning articles (knowledge_array_remove off the
// OLD owner + knowledge_append onto the NEW one) used to leave the old
// owner's open reconcile_needed item still naming the transferred path, and
// an ATTESTED close of that item then refused WHOLE — even for the item's
// other, untouched keys — because refuseAttestationScope's SUBSET check
// (packages/mcp-server/src/tools.ts, pinned by [R9-8a] in
// attested-close.test.ts) correctly sees a path the owner no longer owns.
//
// The fix: a same-store versioned in-place write that makes a record stop
// claiming a path now prunes that path from the record's own open
// reconcile_needed item, in the SAME transaction (SterlingStore.
// pruneReconcileNeeded), and discloses the prune — including a per-path
// drift verdict against the OLD baseline — on the write's receipt
// (`pruned_reconcile_items`). These pin the TOOL half of that fix: the exact
// scenario board 7e779e1f measured, end to end through knowledge_array_remove
// and maintenance_remove.
//
// Harness conventions copied from attested-close.test.ts's gitFixture/
// mkArticle/commitFile (git fixture + SterlingTools({..., repoRoot})).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-09-21T12:00:00.000Z';

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-reconcile-prune-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, git, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, files: { path: string; role?: string }[]): Loose =>
  (
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: files.map((f) => ({ path: f.path, role: f.role ?? 'impl' })),
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

function commitFile(dir: string, git: (...a: string[]) => string, relPath: string, content: string): void {
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  git('add', '-A');
  git('commit', '-qm', `write ${relPath}`);
}

function attestationsOf(rec: Loose): Record<string, Loose> {
  return (rec.baseline_attestations as Record<string, Loose>) ?? {};
}

type PrunedItem = { id: string; removed: boolean; paths: { path: string; drifted: boolean | 'unknown' }[] };
function prunedItemsOf(rec: Loose): PrunedItem[] {
  return (rec.pruned_reconcile_items as PrunedItem[] | undefined) ?? [];
}

// ===========================================================================
// THE BOARD SCENARIO: article A owns [src/a.ts, src/b.ts] with ONE open
// reconcile_needed item naming both. knowledge_array_remove drops src/a.ts
// off A (the file's ownership genuinely moved to B). An attested close of
// A's item for the SURVIVING key src/b.ts must now SUCCEED — before this fix
// it refused WHOLE, exactly as [R9-8a] pins for an unowned key.
// ===========================================================================
test('board 7e779e1f: knowledge_array_remove off the OLD owner prunes the transferred path from its open reconcile_needed item, unblocking an attested close of the surviving key', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    commitFile(dir, git, 'src/other.ts', 'other-v1');
    const articleA = mkArticle(tools, 'owner-a', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const articleB = mkArticle(tools, 'owner-b', [{ path: 'src/other.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'owner-a' — src/a.ts, src/b.ts changed`,
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: articleA.id as string,
    });

    // The transfer: drop src/a.ts off A, append it onto B.
    const removal = tools.knowledgeArrayRemove(articleA.id as string, 'files[path=src/a.ts]', articleA.version as number) as unknown as {
      record: Loose;
    };
    tools.knowledgeAppend(articleB.id as string, 'files', [{ path: 'src/a.ts', role: 'impl' }]);

    // The prune disclosure rides the array_remove's OWN receipt.
    const pruned = prunedItemsOf(removal.record);
    assert.equal(pruned.length, 1, 'exactly one reconcile_needed item was touched');
    assert.equal(pruned[0].id, item.id as string);
    assert.equal(pruned[0].removed, false, 'src/b.ts still remains — the item survives');
    assert.deepEqual(
      pruned[0].paths,
      [{ path: 'src/a.ts', drifted: false }],
      "src/a.ts's bytes never changed since A's baseline was taken — SABOTAGE: a drift verdict computed against anything but the OLD baseline goes RED here"
    );

    // BEFORE THE FIX this refused WHOLE (board 7e779e1f; see [R9-8a] for the
    // exact refusal this reproduces without the fix — pinned by the mutation
    // check below). It now succeeds because the item's file_keys shrank to
    // just ['src/b.ts'], which A still genuinely owns.
    assert.doesNotThrow(() => tools.maintenanceRemove(item.id as string));

    const after = tools.knowledgeGet(articleA.id as string) as unknown as Loose;
    assert.ok('src/b.ts' in attestationsOf(after), 'the surviving key was actually attested');
    assert.ok(!('src/a.ts' in attestationsOf(after)), 'src/a.ts is no longer A\'s to attest — it was pruned, not stamped');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// The drift disclosure's OTHER arm: a pruned path whose bytes DID change
// since the record's old baseline was taken reports drifted:true — pruning
// is bookkeeping, never evidence of reconciliation.
// ===========================================================================
test('board 7e779e1f: the prune disclosure reports drifted:true when the pruned path\'s bytes changed since the OLD baseline', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'drifted-owner', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'drifted-owner' — src/a.ts, src/b.ts changed`,
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id as string,
    });

    // src/a.ts changes AFTER the article's baseline was taken, but BEFORE the
    // shrink that prunes it off the article.
    commitFile(dir, git, 'src/a.ts', 'a-v2-drifted');

    const removal = tools.knowledgeArrayRemove(article.id as string, 'files[path=src/a.ts]', article.version as number) as unknown as {
      record: Loose;
    };

    const pruned = prunedItemsOf(removal.record);
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].id, item.id as string);
    assert.deepEqual(
      pruned[0].paths,
      [{ path: 'src/a.ts', drifted: true }],
      "SABOTAGE: comparing against the NEW (post-write) baseline instead of the OLD one would read this as false/unknown, going RED"
    );
  } finally {
    cleanup();
  }
});
