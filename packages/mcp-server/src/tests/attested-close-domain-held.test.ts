// maintenance_remove on a reconcile_needed item whose owner record is held by a
// DOMAIN store (board b31dfafb).
//
// The item is project-local; its feature_link names a project record that was
// later promoted into a domain store, so the live head of the chain lives in
// another database. An attested close cannot stamp that owner and remove the
// item in one transaction, and decision
// domain-held-subject-queue-items-close-two-step-named-mount-refusal-on-every-lane-label-routed-transaction-retired
// (f2c61919) names maintenance_remove as the close for a domain-held subject.
// These pins cover:
//   - a domain-held head closes the item by ordinary removal, with no baseline
//     attestation;
//   - a project-held head in the same mounted setup still attests exactly as
//     before;
//   - "domain-held" is decided by the physical holder, not the body's scope
//     label, in both directions;
//   - a head no readable store holds still refuses, leaving the item open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, SterlingStore, createDomain } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { seedRecordRaw } from './test-helpers/raw-seed.js';

type Loose = Record<string, unknown>;

const NOW = '2026-10-07T12:00:00.000Z';
const DOMAIN = 'node';

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

/** A git repo that is also a project root, with one mounted domain store.
 *  `seedDomain` writes straight into the domain store before it is mounted. */
function mountedGitFixture(seedDomain?: (domain: SterlingStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attested-close-domain-held-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const projectDb = join(dir, '.sterling', 'sterling.db');
  const domainDb = join(dir, 'domains', DOMAIN, 'sterling.db');
  createDomain(DOMAIN, `test domain ${DOMAIN}`, domainDb);
  if (seedDomain) {
    const raw = new SterlingStore(domainDb);
    try {
      seedDomain(raw);
    } finally {
      raw.close();
    }
  }
  const open = (mounted: boolean) => {
    const store = new MountedStores(projectDb, mounted ? [{ name: DOMAIN, dbPath: domainDb }] : []);
    const tools = new SterlingTools({
      store,
      config: parseConfig({ stack_tags: mounted ? [DOMAIN] : [] }),
      now: () => NOW,
      newId: randomUUID,
      repoRoot: dir,
    });
    return { store, tools };
  };
  let current = open(true);
  return {
    dir,
    get store() {
      return current.store;
    },
    get tools() {
      return current.tools;
    },
    git,
    /** Reopen the project store WITHOUT the domain mount. */
    reopenWithoutDomain: () => {
      current.store.close();
      current = open(false);
    },
    cleanup: () => {
      current.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function commitFile(dir: string, git: (...a: string[]) => string, relPath: string, content: string): void {
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  git('add', '-A');
  git('commit', '-qm', `write ${relPath}`);
}

const refFields = (location: string): Loose => ({
  title: `reference for ${location}`,
  kind: 'doc',
  location,
  summary: 'what this document says',
  source_date: '2026-10-01',
  capture_date: '2026-10-01',
});

const mkRef = (tools: SterlingTools, location: string): Loose =>
  (
    tools.knowledgeCreate('reference_material', refFields(location) as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as {
      record: Loose;
    }
  ).record;

const mintReconcile = (tools: SterlingTools, path: string, ownerId: string): string =>
  tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile '${path}'`, file_keys: [path], feature_link: ownerId }).record
    .id as string;

const openIds = (tools: SterlingTools): string[] =>
  (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);

const attestationsOf = (rec: Loose): Record<string, Loose> => (rec.baseline_attestations as Record<string, Loose>) ?? {};

test('[DH-1] regression b31dfafb: an item keyed to a project record later promoted into a domain record closes through maintenance_remove, with no baseline attestation', () => {
  const fx = mountedGitFixture();
  try {
    commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
    const ref = mkRef(fx.tools, 'docs/guide.md');
    const itemId = mintReconcile(fx.tools, 'docs/guide.md', ref.id as string);

    const promoted = fx.tools.knowledgePromote(ref.id as string, DOMAIN).promoted;
    assert.equal(fx.store.projectStoreHolds(promoted.id), false, 'precondition: the chain head is not in the project store');
    assert.equal(fx.store.scopeOfHolder(promoted.id), `domain:${DOMAIN}`, 'precondition: a mounted domain store holds the chain head');
    assert.equal(fx.store.get(ref.id as string)?.superseded_by, promoted.id, 'precondition: the item\'s feature_link is superseded by the domain head');
    assert.ok(openIds(fx.tools).includes(itemId), 'precondition: the reconcile_needed item is still open');

    const result = fx.tools.maintenanceRemove(itemId) as unknown as Loose;
    assert.equal(result.removed, itemId, 'maintenance_remove closes the item');
    assert.equal(result.baseline_attestation, undefined, 'no baseline was attested: the owner is held by a domain store');
    assert.ok(!openIds(fx.tools).includes(itemId), 'the item has left the queue');

    const head = fx.tools.knowledgeGet(promoted.id) as unknown as Loose;
    assert.deepEqual(attestationsOf(head), {}, 'the domain head carries no attestation');
    assert.equal(head.version, (promoted as unknown as Loose).version, 'the domain head was not written');
  } finally {
    fx.cleanup();
  }
});

test('[DH-2] contrast: in the same mounted setup a project-held owner still goes through baseline attestation unchanged', () => {
  const fx = mountedGitFixture();
  try {
    commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
    const head = fx.git('rev-parse', 'HEAD');
    const ref = mkRef(fx.tools, 'docs/guide.md');
    const itemId = mintReconcile(fx.tools, 'docs/guide.md', ref.id as string);
    assert.equal(fx.store.projectStoreHolds(ref.id as string), true, 'precondition: the project store holds the owner');

    const result = fx.tools.maintenanceRemove(itemId) as unknown as { removed: string; baseline_attestation?: { article_id: string; paths: string[] } };
    assert.equal(result.removed, itemId);
    assert.ok(result.baseline_attestation, 'the close attested the owner\'s baseline');
    assert.equal(result.baseline_attestation!.article_id, ref.id);
    assert.deepEqual(result.baseline_attestation!.paths, ['docs/guide.md']);

    const after = fx.tools.knowledgeGet(ref.id as string) as unknown as Loose;
    const attest = attestationsOf(after)['docs/guide.md'] as { item_id?: string; head_commit?: string; sha256?: string } | undefined;
    assert.ok(attest, 'the project owner carries the attestation');
    assert.equal(attest!.item_id, itemId);
    assert.equal(attest!.head_commit, head);
    assert.equal(attest!.sha256, sha256('guide-v1'));
  } finally {
    fx.cleanup();
  }
});

test('[DH-3] physical holder, not the scope label: a project-held owner labelled domain-scoped still refuses on the attestation mount check, and the item stays open', () => {
  const fx = mountedGitFixture();
  try {
    commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
    // scope is creation-only on the tool surface, so the label/mount disagreement
    // is seeded below the write boundary, straight into the project store.
    const owner = seedRecordRaw(fx.store.project, 'reference_material', { ...refFields('docs/guide.md'), scope: `domain:${DOMAIN}` }, NOW);
    const itemId = mintReconcile(fx.tools, 'docs/guide.md', owner.id);
    assert.equal(fx.store.get(owner.id)?.scope, `domain:${DOMAIN}`, 'precondition: the body is labelled domain-scoped');
    assert.equal(fx.store.projectStoreHolds(owner.id), true, 'precondition: the project store holds it');

    assert.throws(() => fx.tools.maintenanceRemove(itemId), /cannot attest the baseline[\s\S]*has scope='domain:node'/);
    assert.ok(openIds(fx.tools).includes(itemId), 'the item is still open: a label alone does not route the close');
  } finally {
    fx.cleanup();
  }
});

test('[DH-4] physical holder, not the scope label: a domain-held owner labelled project closes by ordinary removal', () => {
  let ownerId = '';
  const fx = mountedGitFixture((domain) => {
    ownerId = seedRecordRaw(domain, 'reference_material', { ...refFields('docs/guide.md'), scope: 'project' }, NOW).id;
  });
  try {
    commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
    const itemId = mintReconcile(fx.tools, 'docs/guide.md', ownerId);
    assert.equal(fx.store.get(ownerId)?.scope, 'project', 'precondition: the domain-held owner is labelled project');
    assert.equal(fx.store.projectStoreHolds(ownerId), false, 'precondition: the project store does not hold it');
    assert.equal(fx.store.scopeOfHolder(ownerId), `domain:${DOMAIN}`, 'precondition: a mounted domain store holds it');

    const result = fx.tools.maintenanceRemove(itemId) as unknown as Loose;
    assert.equal(result.removed, itemId);
    assert.equal(result.baseline_attestation, undefined, 'no attestation: the physical holder is a domain store');
    assert.ok(!openIds(fx.tools).includes(itemId));
  } finally {
    fx.cleanup();
  }
});

test('[DH-5] fail closed: when no readable store holds the chain head, maintenance_remove refuses and the item stays open', () => {
  const fx = mountedGitFixture();
  try {
    commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
    const ref = mkRef(fx.tools, 'docs/guide.md');
    const itemId = mintReconcile(fx.tools, 'docs/guide.md', ref.id as string);
    const promoted = fx.tools.knowledgePromote(ref.id as string, DOMAIN).promoted;

    fx.reopenWithoutDomain();
    assert.equal(fx.store.get(promoted.id), undefined, 'precondition: with the domain unmounted, no store holds the chain head');

    assert.throws(() => fx.tools.maintenanceRemove(itemId), new RegExp(`${itemId}[\\s\\S]*does not resolve to a LIVE[\\s\\S]*Nothing was written`));
    assert.ok(openIds(fx.tools).includes(itemId), 'the item is still open');
  } finally {
    fx.cleanup();
  }
});

// The domain-held close decides its route on a pre-lock read. A concurrent
// board_update that rewrites the item's file_keys after that read must not be
// closed by it: the item is re-read under the project store's lock and the
// close refuses when anything changed. The race is made deterministic by
// running the board_update from inside the first scopeOfHolder call, which is
// the pre-lock holder lookup.
for (const op of ['maintenance_remove', 'board_remove'] as const) {
  test(`[DH-6 ${op}] a concurrent board_update replacing the item's file_keys after the routing read is refused under the lock, and the new debt stays open`, () => {
    const fx = mountedGitFixture();
    try {
      commitFile(fx.dir, fx.git, 'docs/guide.md', 'guide-v1');
      const ref = mkRef(fx.tools, 'docs/guide.md');
      const itemId = mintReconcile(fx.tools, 'docs/guide.md', ref.id as string);
      fx.tools.knowledgePromote(ref.id as string, DOMAIN);

      const store = fx.store;
      const realScopeOfHolder = store.scopeOfHolder.bind(store);
      let raced = false;
      store.scopeOfHolder = (id: string) => {
        if (!raced) {
          raced = true;
          fx.tools.boardUpdate(itemId, { file_keys: ['src/new-debt.ts'] });
        }
        return realScopeOfHolder(id);
      };

      const close = () => (op === 'maintenance_remove' ? fx.tools.maintenanceRemove(itemId) : fx.tools.boardRemove(itemId));
      assert.throws(close, new RegExp(`${itemId}' changed under this call[\\s\\S]*file_keys \\(docs/guide\\.md\\) → \\(src/new-debt\\.ts\\)[\\s\\S]*Nothing was written`));
      assert.ok(raced, 'precondition: the concurrent board_update ran between the routing read and the lock');

      assert.ok(openIds(fx.tools).includes(itemId), 'the rewritten item is still open');
      const after = fx.tools.boardGet(itemId) as unknown as { file_keys?: string[] };
      assert.deepEqual(after.file_keys, ['src/new-debt.ts'], 'the concurrent write is kept');
    } finally {
      fx.cleanup();
    }
  });
}
