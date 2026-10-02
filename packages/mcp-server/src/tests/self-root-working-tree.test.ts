// A working_tree that resolves to THIS project's own root names the project
// itself (Dome Farmer issue entry 454; user ruling 2026-09-28 "Code: self-root =
// own"). treeRootFor resolves it to repoRoot — so the claims check runs instead
// of reporting 'unavailable:unmapped_working_tree' — and pathHasProjectOwner,
// H10's mirrored ownership predicate, counts it as an owner. A genuinely
// foreign tree (an unmapped symbolic/branch name, or another absolute path)
// still resolves nowhere and still owns nothing at the root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-09-28T12:00:00.000Z';

type TreeRootFor = { treeRootFor(r: Record<string, unknown>): { root?: string; unresolved: boolean } };
type OwnerProbe = { pathHasProjectOwner(p: string): boolean };

function harness(repoRoot?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-self-root-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'x');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: repoRoot ?? dir, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

function articleFields(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: `art-${randomUUID().slice(0, 8)}`,
    title: 'an article',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'src/a.mjs', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...overrides,
  };
}

test('treeRootFor: the project root in drive form, /mnt form, trailing slash or other DrvFs case resolves to the project root', () => {
  const ROOT = '/mnt/c/Users/chulf/Dome Farmer';
  const { tools, cleanup } = harness(ROOT);
  try {
    const t = tools as unknown as TreeRootFor;
    for (const wt of ['C:/Users/chulf/Dome Farmer', 'C:\\Users\\chulf\\Dome Farmer\\', 'c:/users/chulf/dome farmer', ROOT, `${ROOT}/`]) {
      assert.deepEqual(t.treeRootFor({ working_tree: wt }), { root: ROOT, unresolved: false }, wt);
    }
    for (const wt of ['chore/retire-knowledge-skills', 'C:/Users/chulf/Comsoft', 'D:/Users/chulf/Dome Farmer']) {
      assert.deepEqual(t.treeRootFor({ working_tree: wt }), { root: undefined, unresolved: true }, `${wt} is foreign and unmapped`);
    }
  } finally {
    cleanup();
  }
});

test('treeRootFor: a drive-form project root matches a /mnt-form working_tree', () => {
  const { tools, cleanup } = harness('C:/Users/chulf/Dome Farmer');
  try {
    const t = tools as unknown as TreeRootFor;
    assert.deepEqual(t.treeRootFor({ working_tree: '/mnt/c/Users/chulf/Dome Farmer/' }), { root: 'C:/Users/chulf/Dome Farmer', unresolved: false });
  } finally {
    cleanup();
  }
});

test('claims check: a self-rooted record is checked against the project root; a foreign tree still reports unmapped', () => {
  const { dir, tools, cleanup } = harness();
  try {
    const ok = tools.knowledgeCreate('feature_article', articleFields({ working_tree: `${dir}/` })) as unknown as Record<string, unknown>;
    assert.equal(ok.claims_check, undefined, 'the check ran and passed — no unavailable disclosure');
    assert.throws(
      () => tools.knowledgeCreate('feature_article', articleFields({ working_tree: dir, files: [{ path: 'src', role: 'impl' }] })),
      /src/,
      'the directory claim is refused — proof the check really ran against the root'
    );
    const foreign = tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'chore/retire-knowledge-skills' })) as unknown as Record<string, unknown>;
    assert.equal(foreign.claims_check, 'unavailable:unmapped_working_tree');
  } finally {
    cleanup();
  }
});

test('pathHasProjectOwner (H10 mirror): a self-rooted article owns its path; a foreign-tree article does not', () => {
  const { dir, tools, cleanup } = harness();
  try {
    const probe = tools as unknown as OwnerProbe;
    tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'chore/retire-knowledge-skills' }));
    assert.equal(probe.pathHasProjectOwner('src/a.mjs'), false, 'foreign tree owns nothing here');
    tools.knowledgeCreate('feature_article', articleFields({ working_tree: `${dir}/` }));
    assert.equal(probe.pathHasProjectOwner('src/a.mjs'), true, 'self-rooted article owns the root path');
  } finally {
    cleanup();
  }
});

type Appending = {
  knowledgeAppend(id: string, field: string, values: unknown[], resolves?: string[]): { record: Record<string, unknown>; warnings: string[] };
};

test('append-join refusal (tools.ts targetWorkingTree): a SELF-ROOTED target discharges the article_missing item; a FOREIGN target is still refused', () => {
  const { dir, tools, cleanup } = harness();
  try {
    writeFileSync(join(dir, 'src', 'b.mjs'), 'x');
    const text = 'article missing: 1 file(s) nothing owns (feature_article or repo-located reference doc) (1 newly created) — create the owning article(s) (§6 H10 / §12 accretion)';
    const open = () => (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);

    const foreign = tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'chore/retire-knowledge-skills' })).record as { id: string };
    const { record: fItem } = tools.maintenanceEnqueue({ reason: 'article_missing', text, file_keys: ['src/b.mjs'], feature_link: foreign.id });
    assert.throws(
      () => (tools as unknown as Appending).knowledgeAppend(foreign.id, 'files', [{ path: 'src/b.mjs', role: 'impl' }], [fItem.id]),
      /working_tree='chore\/retire-knowledge-skills'/,
      'a foreign-tree target establishes no root ownership and is refused by name'
    );
    assert.ok(open().includes(fItem.id), 'the refused item stays open');

    const self = tools.knowledgeCreate('feature_article', articleFields({ working_tree: `${dir}/` })).record as { id: string };
    const { record: sItem } = tools.maintenanceEnqueue({ reason: 'article_missing', text, file_keys: ['src/b.mjs'], feature_link: self.id });
    (tools as unknown as Appending).knowledgeAppend(self.id, 'files', [{ path: 'src/b.mjs', role: 'impl' }], [sItem.id]);
    assert.ok(!open().includes(sItem.id), 'a self-rooted target owns the root path, so the append discharges the item');
  } finally {
    cleanup();
  }
});
