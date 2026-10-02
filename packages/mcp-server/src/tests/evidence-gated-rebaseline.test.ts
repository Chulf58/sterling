// ---------------------------------------------------------------------------
// EVIDENCE-GATED BASELINE ADVANCE on the versioned write path (decision
// [baseline-advance-is-evidence-gated-ordinary-writes-preserve-baselines]).
//
// A versioned write to a feature_article / reference_material used to re-hash
// EVERY owned path and clear baseline_attestations / absence_attestations
// wholesale, so an unrelated write silently erased un-reconciled drift
// (finding a-re-baseline-can-auto-drain-a-reconcile-needed-item-before). The
// rule these pins hold:
//   (a) a write without `resolves` keeps every existing baseline entry and its
//       attestation entry;
//   (b) an owned path with no baseline yet (a newly claimed one) is stamped;
//   (c) a path the record stops claiming drops its baseline and attestation;
//   (d) a `resolves` write re-stamps exactly the resolved items' owned
//       file_keys and clears the attestation only for those paths;
//   (e) every other baseline is untouched.
//
// Harness conventions copied from attested-close.test.ts (gitFixture,
// mkArticle, commitFile, queryDrift) — the attested close needs a git HEAD.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-09-06T12:00:00.000Z';

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-evidence-rebaseline-'));
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
  return { dir, tools, git, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, paths: string[]): Loose =>
  (
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: paths.map((path) => ({ path, role: 'impl' })),
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function commitFile(dir: string, git: (...a: string[]) => string, relPath: string, content: string): void {
  writeFile(dir, relPath, content);
  git('add', '-A');
  git('commit', '-qm', `write ${relPath}`);
}

const filesOf = (paths: string[]) => paths.map((path) => ({ path, role: 'impl' }));
const get = (tools: SterlingTools, id: string): Loose => tools.knowledgeGet(id) as unknown as Loose;
const baselinesOf = (rec: Loose): Record<string, string> => (rec.file_baselines as Record<string, string>) ?? {};
const attestationsOf = (rec: Loose): Record<string, Loose> => (rec.baseline_attestations as Record<string, Loose>) ?? {};

const queryDrift = (tools: SterlingTools, articleId: string): string[] => {
  const env = tools.knowledgeQueryResult({ types: ['feature_article'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as {
    records: Loose[];
  };
  const rec = env.records.find((r) => r.id === articleId);
  return ((rec?.baseline_drift as { changed?: string[] } | undefined)?.changed) ?? [];
};

const enqueue = (tools: SterlingTools, articleId: string, keys: string[]): string =>
  tools.maintenanceEnqueue({
    reason: 'reconcile_needed',
    text: `reconcile ${keys.join(', ')}`,
    file_keys: keys,
    feature_link: articleId,
  }).record.id as string;

// (a) — SABOTAGE: the old whole-record computeBaselines on every write → the
// drifted path's baseline advances to its current bytes and drift vanishes.
test('[EG-1] an ordinary write (no resolves) after an owned file changed leaves that path\'s baseline unchanged, and the drift is still reported', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'eg-preserve', ['src/a.ts']);
    assert.equal(baselinesOf(article)['src/a.ts'], sha256('a-v1'), 'precondition: create stamped the baseline');

    writeFile(dir, 'src/a.ts', 'a-v2');
    assert.deepEqual(queryDrift(tools, article.id as string), ['src/a.ts'], 'precondition: the drift is visible before the write');

    tools.knowledgeUpdate(article.id as string, { what_it_does: 'an unrelated prose edit' });

    const after = get(tools, article.id as string);
    assert.equal(baselinesOf(after)['src/a.ts'], sha256('a-v1'), 'the unrelated write must NOT advance the drifted path\'s baseline');
    assert.deepEqual(queryDrift(tools, article.id as string), ['src/a.ts'], 'the un-reconciled drift is still reported after the write');
  } finally {
    cleanup();
  }
});

// (a) through every surface that merges through the same path.
test('[EG-1b] knowledge_append / knowledge_edit / knowledge_array_remove preserve a drifted baseline exactly like knowledge_update', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'eg-surfaces', ['src/a.ts']);
    writeFile(dir, 'src/a.ts', 'a-v2');
    const id = article.id as string;

    tools.knowledgeAppend(id, 'history', [{ date: NOW, event: 'appended' }]);
    assert.equal(baselinesOf(get(tools, id))['src/a.ts'], sha256('a-v1'), 'knowledge_append kept the baseline');

    tools.knowledgeEdit(id, 'what_it_does', 'x', 'y');
    assert.equal(baselinesOf(get(tools, id))['src/a.ts'], sha256('a-v1'), 'knowledge_edit kept the baseline');

    tools.knowledgeArrayRemove(id, 'history[event=appended]', get(tools, id).version as number);
    assert.equal(baselinesOf(get(tools, id))['src/a.ts'], sha256('a-v1'), 'knowledge_array_remove kept the baseline');

    assert.deepEqual(queryDrift(tools, id), ['src/a.ts'], 'the drift survived all three writes');
  } finally {
    cleanup();
  }
});

// (b) + (e)
test('[EG-2] a newly claimed files[] path gets a baseline; an existing drifted path keeps its old one', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/c.ts', 'c-v1');
    const article = mkArticle(tools, 'eg-new-claim', ['src/a.ts']);
    writeFile(dir, 'src/a.ts', 'a-v2');

    tools.knowledgeUpdate(article.id as string, { files: filesOf(['src/a.ts', 'src/c.ts']) });

    const b = baselinesOf(get(tools, article.id as string));
    assert.equal(b['src/c.ts'], sha256('c-v1'), 'the newly claimed path is hashed and stamped');
    assert.equal(b['src/a.ts'], sha256('a-v1'), 'the existing drifted path is untouched');
  } finally {
    cleanup();
  }
});

// (c)
test('[EG-3] a path the record stops claiming loses its baseline and its attestation entry', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'eg-unclaim', ['src/a.ts', 'src/b.ts']);
    const id = article.id as string;
    commitFile(dir, git, 'src/b.ts', 'b-v2');
    tools.maintenanceRemove(enqueue(tools, id, ['src/b.ts']));
    assert.ok(attestationsOf(get(tools, id))['src/b.ts'], 'precondition: b carries an attestation');

    tools.knowledgeUpdate(id, { files: filesOf(['src/a.ts']) });

    const after = get(tools, id);
    assert.ok(!('src/b.ts' in baselinesOf(after)), 'the departed path has no baseline');
    assert.ok(!('src/b.ts' in attestationsOf(after)), 'the departed path has no attestation entry');
    assert.equal(baselinesOf(after)['src/a.ts'], sha256('a-v1'), 'the still-claimed path keeps its baseline');
  } finally {
    cleanup();
  }
});

// (d) + (e) — SABOTAGE: re-stamp every owned path on a resolves write → b's
// old baseline advances and its drift vanishes.
test('[EG-4] a resolves write re-stamps only the resolved item\'s paths and keeps another drifted path\'s old baseline', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'eg-resolves', ['src/a.ts', 'src/b.ts']);
    const id = article.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    writeFile(dir, 'src/b.ts', 'b-v2');
    const item = enqueue(tools, id, ['src/a.ts']);

    tools.knowledgeUpdate(id, { what_it_does: 'reconciled a' }, [item]);

    const b = baselinesOf(get(tools, id));
    assert.equal(b['src/a.ts'], sha256('a-v2'), 'the resolved path is re-stamped to its current bytes');
    assert.equal(b['src/b.ts'], sha256('b-v1'), 'the unresolved drifted path keeps its old baseline');
    assert.deepEqual(queryDrift(tools, id), ['src/b.ts'], 'only the unresolved path still reads as drifted');
  } finally {
    cleanup();
  }
});

// Attestation provenance — SABOTAGE: clear baseline_attestations wholesale
// on every write → a's attestation disappears on the unrelated writes below.
test('[EG-5] an attested path untouched by a write keeps its attestation; a resolves write clears the attestation only for the path it re-stamps', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'eg-attest', ['src/a.ts', 'src/b.ts']);
    const id = article.id as string;
    commitFile(dir, git, 'src/a.ts', 'a-v2');
    commitFile(dir, git, 'src/b.ts', 'b-v2');
    tools.maintenanceRemove(enqueue(tools, id, ['src/a.ts']));
    const attested = get(tools, id);
    const aAttestation = attestationsOf(attested)['src/a.ts'];
    assert.ok(aAttestation, 'precondition: a is attested');
    assert.equal(baselinesOf(attested)['src/a.ts'], sha256('a-v2'), 'precondition: a is attested at a-v2');

    // an ordinary write keeps a's attestation byte-for-byte
    tools.knowledgeUpdate(id, { what_it_does: 'unrelated' });
    assert.deepEqual(attestationsOf(get(tools, id))['src/a.ts'], aAttestation, 'an ordinary write keeps the attestation');

    // a resolves write on b re-stamps b and leaves a's attestation alone
    tools.knowledgeUpdate(id, { what_it_does: 'reconciled b' }, [enqueue(tools, id, ['src/b.ts'])]);
    const afterB = get(tools, id);
    assert.equal(baselinesOf(afterB)['src/b.ts'], sha256('b-v2'), 'b re-stamped');
    assert.deepEqual(attestationsOf(afterB)['src/a.ts'], aAttestation, 'a resolves write that did not touch a keeps a\'s attestation');

    // a resolves write that re-stamps a clears a's attestation — the baseline is
    // now content-reconcile provenance, not attested provenance
    tools.knowledgeUpdate(id, { what_it_does: 'reconciled a' }, [enqueue(tools, id, ['src/a.ts'])]);
    const afterA = get(tools, id);
    assert.equal(baselinesOf(afterA)['src/a.ts'], sha256('a-v2'), 'a re-stamped');
    assert.ok(!('src/a.ts' in attestationsOf(afterA)), 'the re-stamped path loses its attestation marker');
  } finally {
    cleanup();
  }
});

// Absence provenance — an unbaselined path is stamped only when it can be
// hashed, so a still-absent path's absence attestation survives an ordinary
// write. SABOTAGE: clear the markers of every unbaselined owned path → red.
test('[EG-6] a still-absent path keeps its absence attestation across an ordinary write; a resolves write naming it clears it', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'docs/gone.md', 'draft');
    const article = mkArticle(tools, 'eg-absence', ['src/a.ts', 'docs/gone.md']);
    const id = article.id as string;
    git('rm', '-q', 'docs/gone.md');
    git('commit', '-qm', 'delete draft');
    tools.maintenanceRemove(enqueue(tools, id, ['docs/gone.md']));
    const absence = (get(tools, id).absence_attestations as Record<string, Loose> | undefined)?.['docs/gone.md'];
    assert.ok(absence, 'precondition: gone.md carries an absence attestation');

    tools.knowledgeUpdate(id, { what_it_does: 'unrelated' });
    const afterOrdinary = get(tools, id);
    assert.deepEqual((afterOrdinary.absence_attestations as Record<string, Loose>)['docs/gone.md'], absence, 'an ordinary write keeps the absence attestation');
    assert.ok(!('docs/gone.md' in baselinesOf(afterOrdinary)), 'and stamps no baseline for the absent path');

    tools.knowledgeUpdate(id, { what_it_does: 'reconciled gone' }, [enqueue(tools, id, ['docs/gone.md'])]);
    assert.ok(!('docs/gone.md' in ((get(tools, id).absence_attestations as Record<string, Loose> | undefined) ?? {})), 'the re-stamped path loses its absence marker');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FIX ROUND (review of the first cut). Each pin below names the defect it
// guards; each failed against the first cut.
// ---------------------------------------------------------------------------

// Normalization, create: a non-normalized files[].path must baseline under
// the NORMALIZED key the store persists, or the drift check never finds it.
test('[EG-7] create with a non-normalized path (./src/a.ts) stamps the baseline under the normalized key', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'eg-norm-create', ['./src/a.ts']);
    assert.deepEqual(baselinesOf(get(tools, article.id as string)), { 'src/a.ts': sha256('a-v1') }, 'one baseline, under the normalized key');
  } finally {
    cleanup();
  }
});

// Normalization, update: re-spelling an owned path is not a new claim.
test('[EG-8] updating files[] to an equivalent spelling (./src/a.ts) keeps the drifted baseline and emits no orphan key', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'eg-norm-update', ['src/a.ts']);
    writeFile(dir, 'src/a.ts', 'a-v2');

    tools.knowledgeUpdate(article.id as string, { files: filesOf(['./src/a.ts']) });

    assert.deepEqual(baselinesOf(get(tools, article.id as string)), { 'src/a.ts': sha256('a-v1') }, 'the old baseline stands, no ./ orphan');
    assert.deepEqual(queryDrift(tools, article.id as string), ['src/a.ts'], 'the drift is still reported');
  } finally {
    cleanup();
  }
});

// reference_material: location is its path-bearing field.
test('[EG-9] reference_material (kind:doc): an ordinary write keeps a drifted location baseline; a resolves write re-stamps it', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'docs/r.md', 'r-v1');
    const ref = (
      tools.knowledgeCreate('reference_material', {
        title: 'r',
        kind: 'doc',
        location: 'docs/r.md',
        summary: 'x',
        source_date: '2026-09-06',
        capture_date: '2026-09-06',
      } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
    ).record;
    const id = ref.id as string;
    writeFile(dir, 'docs/r.md', 'r-v2');

    tools.knowledgeUpdate(id, { summary: 'unrelated' });
    assert.equal(baselinesOf(get(tools, id))['docs/r.md'], sha256('r-v1'), 'an ordinary write keeps the location baseline');

    tools.knowledgeUpdate(id, { summary: 'reconciled' }, [enqueue(tools, id, ['docs/r.md'])]);
    assert.equal(baselinesOf(get(tools, id))['docs/r.md'], sha256('r-v2'), 'a resolves write re-stamps it');
  } finally {
    cleanup();
  }
});

// Append-join lane: knowledge_append to files[] WITH resolves validates its
// claims inside dischargeAppendJoin; the advance must see those claims.
test('[EG-10] knowledge_append to files[] with resolves re-stamps the resolved reconcile item\'s already-owned drifted path', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/c.ts', 'c-v1');
    const article = mkArticle(tools, 'eg-append-resolves', ['src/a.ts']);
    const id = article.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    const item = enqueue(tools, id, ['src/a.ts']);

    tools.knowledgeAppend(id, 'files', [{ path: 'src/c.ts', role: 'impl' }], [item]);

    const b = baselinesOf(get(tools, id));
    assert.equal(b['src/a.ts'], sha256('a-v2'), 'the resolved path is re-stamped');
    assert.equal(b['src/c.ts'], sha256('c-v1'), 'the appended path is stamped');
    assert.deepEqual(queryDrift(tools, id), [], 'nothing reads as drifted');
  } finally {
    cleanup();
  }
});

// knowledge_split: the parent keeps the resolved path, so the parent's
// baseline advance must see the split's claims.
test('[EG-11] knowledge_split with resolves re-stamps the resolved path the parent keeps', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const parent = mkArticle(tools, 'eg-split-parent', ['src/a.ts', 'src/b.ts']);
    const id = parent.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    const item = enqueue(tools, id, ['src/a.ts']);

    tools.knowledgeSplit({
      id,
      children: [{ slug: 'eg-split-child', title: 'c', what_it_does: 'c', intended_behavior: 'c', move_files: ['src/b.ts'], move_ac_ids: [] }],
      parent_what_it_does: 'a only',
      resolves: [item],
    } as unknown as Parameters<SterlingTools['knowledgeSplit']>[0]);

    assert.equal(baselinesOf(get(tools, id))['src/a.ts'], sha256('a-v2'), 'the resolved path the parent keeps is re-stamped');
    assert.deepEqual(queryDrift(tools, id), [], 'the parent reads clean');
  } finally {
    cleanup();
  }
});

// knowledge_extract: reviewed for the split shape (nested update without
// resolves, claims removed separately). It cannot occur on a baseline-bearing
// source: validateExtractResolveClaim requires the item's file_keys to overlap
// the source's `file_keys` FIELD, which feature_article (files[]) and
// reference_material (location) do not have — so no reconcile item can ride an
// extract from either. Pinned so a change to that rule re-opens the question.
test('[EG-12] knowledge_extract cannot carry a resolves claim from a feature_article, so it never drains drift beside an un-advanced baseline', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const source = mkArticle(tools, 'eg-extract-source', ['src/a.ts']);
    const id = source.id as string;
    tools.knowledgeUpdate(id, { what_it_does: 'keep this. lift this passage.' });
    writeFile(dir, 'src/a.ts', 'a-v2');
    const item = enqueue(tools, id, ['src/a.ts']);

    assert.throws(
      () =>
        tools.knowledgeExtract({
          id,
          field: 'what_it_does',
          find: ' lift this passage.',
          new_record: { type: 'decision', fields: { title: 'lifted', statement: 'lift this passage', alternatives_rejected: [], rationale: 'r' } },
          resolves: [item],
        }),
      /do not overlap the extract source/
    );
    assert.equal(baselinesOf(get(tools, id))['src/a.ts'], sha256('a-v1'), 'the refused extract advanced nothing');
    assert.ok(tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item), 'and closed nothing');
  } finally {
    cleanup();
  }
});

// The claim race: an item widened by another writer AFTER this write's
// pre-transaction validation read and BEFORE its drain. Simulated by wrapping
// the (private) validateResolveClaim so the widen lands right after it returns
// — the exact window the review named. The re-stamp set must match what the
// drain actually closes.
test('[EG-13] an item widened between claim validation and the drain: the write re-stamps exactly the keys it drains', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'eg-race', ['src/a.ts', 'src/b.ts']);
    const id = article.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    writeFile(dir, 'src/b.ts', 'b-v2');
    const item = enqueue(tools, id, ['src/a.ts']);

    const t = tools as unknown as { validateResolveClaim: (...a: unknown[]) => unknown };
    const original = t.validateResolveClaim.bind(tools);
    let widened = false;
    t.validateResolveClaim = (...a: unknown[]) => {
      const claim = original(...a);
      if (!widened) {
        widened = true;
        // another session's mint folds b into the SAME open item (one item per owner, keys unioned)
        assert.equal(enqueue(tools, id, ['src/b.ts']), item, 'precondition: the second mint folded into the claimed item');
      }
      return claim;
    };

    const result = tools.knowledgeUpdate(id, { what_it_does: 'reconciled' }, [item]) as unknown as { resolved_items?: { file_keys?: string[] }[] };
    assert.deepEqual([...(result.resolved_items?.[0]?.file_keys ?? [])].sort(), ['src/a.ts', 'src/b.ts'], 'precondition: the drain closed the widened item');

    const b = baselinesOf(get(tools, id));
    assert.equal(b['src/a.ts'], sha256('a-v2'), 'a re-stamped');
    assert.equal(b['src/b.ts'], sha256('b-v2'), 'b, drained with the widened item, is re-stamped too — never drained unstamped');
  } finally {
    cleanup();
  }
});

// Append-join, article_missing lane (re-review MEDIUM): rule (d) has no lane
// exception. An article_missing item the append FULLY drains is resolved, so
// its already-owned paths are re-stamped like any resolved item's.
const enqueueMissing = (tools: SterlingTools, articleId: string, keys: string[]): string =>
  tools.maintenanceEnqueue({
    reason: 'article_missing',
    text: `'owner' does not yet own ${keys.join(', ')}`,
    file_keys: keys,
    feature_link: articleId,
  }).record.id as string;

const isOpen = (tools: SterlingTools, id: string): boolean =>
  tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === id);

test('[EG-14] knowledge_append fully draining an article_missing item re-stamps the item\'s already-owned drifted path', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/new.ts', 'new-v1');
    const article = mkArticle(tools, 'eg-missing-full', ['src/a.ts']);
    const id = article.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    const item = enqueueMissing(tools, id, ['src/a.ts', 'src/new.ts']);

    tools.knowledgeAppend(id, 'files', [{ path: 'src/new.ts', role: 'impl' }], [item]);

    assert.ok(!isOpen(tools, item), 'precondition: the append fully drained the item (a.ts already owned, new.ts joined)');
    const b = baselinesOf(get(tools, id));
    assert.equal(b['src/new.ts'], sha256('new-v1'), 'the joined path is stamped');
    assert.equal(b['src/a.ts'], sha256('a-v2'), 'the drained item\'s already-owned path is re-stamped');
  } finally {
    cleanup();
  }
});

test('[EG-15] knowledge_append that only PARTIALLY retires an article_missing item does not advance the item\'s already-owned drifted path', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/new.ts', 'new-v1');
    commitFile(dir, git, 'src/other.ts', 'other-v1');
    const article = mkArticle(tools, 'eg-missing-partial', ['src/a.ts']);
    const id = article.id as string;
    writeFile(dir, 'src/a.ts', 'a-v2');
    const item = enqueueMissing(tools, id, ['src/a.ts', 'src/new.ts', 'src/other.ts']);

    tools.knowledgeAppend(id, 'files', [{ path: 'src/new.ts', role: 'impl' }], [item]);

    assert.ok(isOpen(tools, item), 'precondition: other.ts is still unowned, so the item is retained, not drained');
    const b = baselinesOf(get(tools, id));
    assert.equal(b['src/new.ts'], sha256('new-v1'), 'the joined path is stamped (newly claimed)');
    assert.equal(b['src/a.ts'], sha256('a-v1'), 'a retained item resolves nothing: a keeps its old baseline');
    assert.deepEqual(queryDrift(tools, id), ['src/a.ts'], 'and its drift is still reported');
  } finally {
    cleanup();
  }
});
