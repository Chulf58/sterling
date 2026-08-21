// VERSION-CONFLICT DISCLOSURE on stale-read writes (board 13bd5507, the
// minimal half left live after decision lane-concept-first-slice-scope
// deferred the knowledge_claim lease): a write addressed to a record that
// was SUPERSEDED while the writer held it must refuse EARLY with an
// informative version-conflict message naming the live head — never fall
// through to the store's opaque low-context refusal, and never fork or
// clobber. The store's own supersede() guard already makes the fork
// impossible; this pins the TOOL-LAYER surface the stale reader actually
// sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-08-21T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stale-write-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW }) as unknown as {
    knowledgeCreate: (type: string, fields: Loose) => { record: Loose };
    knowledgeUpdate: (id: string, body: Loose) => Loose;
    knowledgeAppend: (id: string, field: string, entries: unknown[]) => Loose;
    knowledgeGet: (id: string) => Loose;
  };
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, cleanup };
}

function mkArticle(tools: ReturnType<typeof harness>['tools'], slug: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: `${slug} does things`,
    intended_behavior: `${slug} intends`,
    files: [{ path: 'src/x.mjs', role: 'owner' }],
    current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: '2026-08-21T00:00:00.000Z', event: 'genesis' }],
    live_test_refs: [],
  }).record;
}

test('stale-read knowledge_update: addressing a superseded uuid refuses with a version-conflict message naming the live head; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'stale-write-subject');
    tools.knowledgeUpdate(v1.id as string, { intended_behavior: 'v2 behavior' }); // someone else moved the head
    const headBefore = tools.knowledgeGet('stale-write-subject') as Loose;
    assert.equal(headBefore.version, 2, 'precondition: head is v2');

    assert.throws(
      () => tools.knowledgeUpdate(v1.id as string, { intended_behavior: 'the stale writer clobbers' }),
      (err: Error) => {
        assert.match(err.message, /version conflict/i, 'the refusal is named as a version conflict');
        assert.ok(err.message.includes(headBefore.id as string), 'the live head id is named');
        assert.ok(err.message.includes('stale-write-subject'), 'the head slug is named');
        assert.match(err.message, /re-read/i, 'the remedy is to re-read the head and re-apply');
        assert.match(err.message, /nothing was written/i, 'discloses that no write landed');
        return true;
      }
    );
    const headAfter = tools.knowledgeGet('stale-write-subject') as Loose;
    assert.equal(headAfter.version, 2, 'the head is untouched — no clobber, no fork');
    assert.equal(headAfter.id, headBefore.id, 'the head record is the same one');
    assert.equal((tools.knowledgeGet(v1.id as string) as Loose).status, 'superseded', 'the stale record is unaffected');
  } finally {
    cleanup();
  }
});

test('stale-read knowledge_append/knowledge_edit inherit the version-conflict refusal through the one update path', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'stale-append-subject');
    tools.knowledgeUpdate(v1.id as string, { intended_behavior: 'v2 behavior' });

    assert.throws(
      () => tools.knowledgeAppend(v1.id as string, 'history', [{ date: '2026-08-21T01:00:00.000Z', event: 'stale append' }]),
      /knowledge_append: version conflict/i,
      'append addressed to the stale uuid refuses as a version conflict, under its own tool name'
    );
    assert.throws(
      () => (tools as unknown as { knowledgeEdit: (id: string, f: string, a: string, b: string) => Loose }).knowledgeEdit(
        v1.id as string, 'intended_behavior', 'v2 behavior', 'edited'
      ),
      /knowledge_edit: version conflict/i,
      'edit addressed to the stale uuid refuses as a version conflict, under its own tool name'
    );
    assert.equal((tools.knowledgeGet('stale-append-subject') as Loose).version, 2, 'the head is untouched');
  } finally {
    cleanup();
  }
});

test('stale-read refusal never fires on a live head or a slug address — slugs always serve the head', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'stale-slug-subject');
    tools.knowledgeUpdate(v1.id as string, { intended_behavior: 'v2 behavior' });
    const rec = tools.knowledgeUpdate('stale-slug-subject', { intended_behavior: 'v3 via slug' }) as Loose;
    assert.equal(rec.version, 3, 'a slug address resolves the head and updates normally — no false conflict');
  } finally {
    cleanup();
  }
});

test('stale-read refusal stays HONEST past resolution limits: a >32-hop chain advises slug resolution instead of naming a possibly-wrong head', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'stale-deep-subject');
    for (let i = 0; i < 35; i++) {
      tools.knowledgeUpdate('stale-deep-subject', { intended_behavior: `behavior rev ${i + 2}` });
    }
    assert.throws(
      () => tools.knowledgeUpdate(v1.id as string, { intended_behavior: 'stale writer far behind' }),
      (err: Error) => {
        assert.match(err.message, /version conflict/i);
        assert.match(err.message, /slug/i, 'past the hop limit the remedy is slug resolution, never a confidently-named stale head');
        assert.match(err.message, /nothing was written/i);
        return true;
      }
    );
    const head = tools.knowledgeGet('stale-deep-subject') as Loose;
    assert.equal(head.version, 36, 'the deep head is untouched');
  } finally {
    cleanup();
  }
});
