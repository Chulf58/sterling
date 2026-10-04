// The session-end duty rules H10 and the OpenCode settlement share
// (scripts/hooks/lib/session-duties.mjs). The item texts are pinned to the
// exact strings H10 wrote before the extraction, so a Claude Code queue item
// stays byte-identical; the h10-*.test.mjs suite pins the hook's behaviour.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as duties from '../hooks/lib/session-duties.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
});

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-duties-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const env = (type, at) => ({ id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] });
const finding = (at) => ({ ...env('research_finding', at), question: 'q?', answer: 'a', source_urls: [], source_date: '2026-09-01', capture_date: '2026-09-02' });
const conceptArticle = (family, at, path = 'src/x.mjs') => ({
  ...env('feature_article', at),
  slug: `${family}-article`,
  title: 't',
  what_it_does: 'w',
  intended_behavior: 'i',
  files: [{ path, role: 'impl' }],
  file_baselines: {},
  current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [{ date: at, event: 'brief' }],
  live_test_refs: [],
  concept_family: family,
});

test('golden: the four item texts are byte-identical to what H10 wrote before the extraction', () => {
  assert.equal(
    duties.articleMissingText(['a', 'b'], { newlyCreated: 1 }),
    'article missing: 2 file(s) nothing owns (feature_article or repo-located reference doc) (1 newly created) — create the owning article(s) (§6 H10 / §12 accretion)'
  );
  assert.equal(duties.articleMissingText(['a']), 'article missing: 1 file(s) nothing owns (feature_article or repo-located reference doc) — create the owning article(s) (§6 H10 / §12 accretion)');
  assert.equal(
    duties.conceptArticleMissingText('fam'),
    "concept article missing: design settled for concept family 'fam' and the session ended without its concept article — create/update the feature_article with concept_family 'fam'"
  );
  assert.equal(duties.researchOwedText('q1; q2'), 'research owed: session research not captured (queries/agents: q1; q2)');
  assert.equal(duties.captureOwedText(3, ''), 'capture owed: direct-mode session touched 3 file(s) and ended without capture');
});

test('golden: systemTodo builds the envelope H10 enqueued, field for field and in order', () => {
  const t = duties.systemTodo('2026-10-02T00:00:00.000Z', { text: 'x', system_reason: 'research_owed' });
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(t), ['id', 'type', 'created_at', 'updated_at', 'author', 'status', 'superseded_by', 'links', 'scope', 'stack_tags', 'text', 'source', 'system_reason']);
  assert.deepEqual({ ...t, id: null }, {
    id: null, type: 'todo', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', author: 'system', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [], text: 'x', source: 'system', system_reason: 'research_owed',
  });
  const k = duties.systemTodo('2026-10-02T00:00:00.000Z', { text: 'y', system_reason: 'capture_owed', file_keys: ['a'] });
  assert.deepEqual(Object.keys(k).slice(-4), ['text', 'source', 'system_reason', 'file_keys']);
});

test('isValidAt accepts only canonical ISO stamps', () => {
  assert.equal(duties.isValidAt('2026-10-02T00:00:00.000Z'), true);
  for (const bad of ['0', 'n/a', undefined, null, '2026-10-02', '2026-13-45T00:00:00.000Z']) assert.equal(duties.isValidAt(bad), false, String(bad));
});

test('no_capture cutoffs are lane-scoped; a legacy declaration is the capture lane and "all" covers both', () => {
  const ev = [
    { kind: 'no_capture', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'no_capture', lane: 'research', at: '2026-10-02T02:00:00.000Z' },
    { kind: 'no_capture', lane: 'bogus', at: '2026-10-02T09:00:00.000Z' },
    { kind: 'no_capture', lane: 'capture', at: 'n/a' },
  ];
  assert.deepEqual(duties.noCaptureCutoffs(ev), { capture: '2026-10-02T01:00:00.000Z', research: '2026-10-02T02:00:00.000Z' });
  assert.deepEqual(duties.noCaptureCutoffs([...ev, { kind: 'no_capture', lane: 'all', at: '2026-10-02T03:00:00.000Z' }]), { capture: '2026-10-02T03:00:00.000Z', research: '2026-10-02T03:00:00.000Z' });
  assert.equal(duties.dischargedByCutoff('2026-10-02T01:00:00.000Z', '2026-10-02T01:00:00.000Z'), true);
  assert.equal(duties.dischargedByCutoff('0', '2026-10-02T01:00:00.000Z'), false, 'a malformed at is never covered');
  assert.equal(duties.dischargedByCutoff('2026-10-02T00:00:00.000Z', null), false);
});

test('concept families anchor at the earliest valid at, and a family with none anchors null', () => {
  const fam = duties.conceptFamiliesFrom([
    { kind: 'concept_designed', detail: 'a', at: '2026-10-02T02:00:00.000Z' },
    { kind: 'concept_designed', detail: 'a', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'concept_designed', detail: 'b', at: '0' },
    { kind: 'concept_designed', detail: '', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'no_capture', detail: 'c', at: '2026-10-02T01:00:00.000Z' },
  ]);
  assert.deepEqual([...fam.entries()], [['a', '2026-10-02T01:00:00.000Z'], ['b', null]]);
});

test('capture, research and concept satisfaction read the store from the window start', () =>
  withStore((store) => {
    store.create(finding('2026-10-02T05:00:00.000Z'));
    assert.equal(duties.capturedSince(store, '2026-10-02T04:00:00.000Z'), true);
    assert.equal(duties.capturedSince(store, '2026-10-02T06:00:00.000Z'), false);
    assert.equal(duties.researchCapturedSince(store, '2026-10-02T04:00:00.000Z'), true);
    assert.equal(duties.researchCapturedSince(store, '2026-10-02T06:00:00.000Z'), false);
    store.create(conceptArticle('fam', '2026-10-02T05:00:00.000Z'));
    const fams = new Map([['fam', '2026-10-02T05:10:00.000Z'], ['other', '2026-10-02T05:10:00.000Z'], ['nul', null]]);
    assert.deepEqual(duties.unmetConceptFamilies(store, fams, '2026-10-02T05:10:00.000Z'), ['other', 'nul'], 'an article 10 minutes before its event satisfies through the pre-event window');
    assert.deepEqual(duties.unmetConceptFamilies(store, new Map([['fam', '2026-10-02T06:00:00.000Z']]), '2026-10-02T06:00:00.000Z'), ['fam'], 'an article an hour before its event does not');
  }));

test('ownership join and demand exemption', () =>
  withStore((store, dir) => {
    store.create(conceptArticle('fam', '2026-10-02T05:00:00.000Z', 'src/owned.mjs'));
    const { isUnowned, ownerRows } = duties.ownershipJoin(store, dir);
    assert.equal(isUnowned('src/owned.mjs'), false);
    assert.equal(isUnowned('src/free.mjs'), true);
    assert.equal(ownerRows('src/owned.mjs').length, 1);
    const exempt = duties.demandExemption({ article_demand: { ignore_globs: ['**/*.uid'] } }, new Set(['architecture.md']));
    assert.equal(exempt('architecture.md'), true);
    assert.equal(exempt('a/b.gd.uid'), true);
    assert.equal(exempt('a/b.gd'), false);
    assert.equal(duties.hasOpenSystemTodo(store, 'research_owed'), false);
    store.enqueueSystemTodo(duties.systemTodo('2026-10-02T00:00:00.000Z', { text: duties.researchOwedText('q'), system_reason: 'research_owed' }));
    assert.equal(duties.hasOpenSystemTodo(store, 'research_owed'), true);
  }));

test('openDutyRecords.close closes every domain store and returns the close errors instead of throwing', () =>
  withStore((store, dir) => {
    const paths = { a: join(dir, 'a.db'), b: join(dir, 'b.db'), gone: join(dir, 'gone.db') };
    writeFileSync(paths.a, '');
    writeFileSync(paths.b, '');
    const closed = [];
    const opener = (dbPath) => ({
      query: () => [{ id: dbPath }],
      close: () => {
        closed.push(dbPath);
        throw new Error(`close boom ${dbPath === paths.a ? 'a' : 'b'}`);
      },
    });
    const unreadable = [];
    const records = duties.openDutyRecords(store, { stack_tags: ['a', 'gone', 'b'], domain_paths: paths }, { opener, onUnreadable: (name) => unreadable.push(name) });
    assert.deepEqual(records.query({ types: ['decision'], cap: 10 }).map((r) => r.id), [paths.a, paths.b], 'project first (empty), then each domain store that exists');
    let errors;
    assert.doesNotThrow(() => (errors = records.close()));
    assert.deepEqual(closed, [paths.a, paths.b], 'the second store is closed although the first close threw');
    assert.deepEqual(errors, [{ name: 'a', error: 'close boom a' }, { name: 'b', error: 'close boom b' }]);
    assert.deepEqual(unreadable, [], 'a close error is not an unreadable store');
    assert.deepEqual(records.close(), [], 'a second close has nothing left to close');
  }));
