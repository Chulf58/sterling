import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// Size surfacing (board a382af6b, second half — the write-time oversize warning
// and article_oversize lane pre-exist, board 8390f8fa): query digest lines
// carry size_chars, and knowledge_stats answers the drill-down (per-id) and the
// landscape (no-arg aggregate). Conductor-authored alongside the
// implementation under the one-go working mode (user-stated 2026-08-21); the
// oracle numbers derive from recordSizes, the same decomposition the oversize
// lane judges.

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stats-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, history: { date: string; event: string }[]) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does a thing',
    intended_behavior: 'behaves',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history,
    live_test_refs: [],
  }).record;

type Stats = { knowledgeStats(id?: string): Record<string, unknown> };
const stats = (tools: SterlingTools) => (tools as unknown as Stats).knowledgeStats.bind(tools as unknown as Stats);

test('digest lines carry size_chars, and history never inflates it (body-only, the number a split can fix)', () => {
  const { tools, cleanup } = harness();
  try {
    const longHistory = Array.from({ length: 15 }, (_, i) => ({ date: NOW, event: `entry ${i}: ${'x'.repeat(200)}` }));
    mkArticle(tools, 'lean', [{ date: NOW, event: 'seed' }]);
    mkArticle(tools, 'fat-history', longHistory);
    const digests = (tools.knowledgeQueryResult({ types: ['feature_article'], projection: 'digest' }) as unknown as {
      records: { slug: string; size_chars: number }[];
    }).records;
    const lean = digests.find((d) => d.slug === 'lean')!;
    const fat = digests.find((d) => d.slug === 'fat-history')!;
    assert.equal(typeof lean.size_chars, 'number');
    assert.ok(lean.size_chars > 0, 'size rides every digest line');
    // The two articles differ ONLY in history and slug (same-length slugs would
    // be byte-identical bodies; these differ by a few chars of slug/title/path).
    assert.ok(Math.abs(fat.size_chars - lean.size_chars) < 50, `history must not count: lean=${lean.size_chars} fat=${fat.size_chars}`);
  } finally {
    cleanup();
  }
});

test('knowledge_stats(id): body/history decomposition, composition counts, threshold verdict — addressable by slug', () => {
  const { tools, cleanup } = harness();
  try {
    mkArticle(tools, 'measured', [
      { date: NOW, event: 'seed' },
      { date: NOW, event: 'second entry with some heft '.repeat(10) },
    ]);
    const s = stats(tools)('measured') as {
      slug: string;
      body_chars: number;
      history_chars: number;
      total_chars: number;
      history_entries: number;
      supersedes_count: number;
      oversize_threshold: number;
      over_threshold: boolean;
    };
    assert.equal(s.slug, 'measured', 'the id ladder (slug form) resolves');
    assert.ok(s.body_chars > 0 && s.history_chars > 0);
    assert.equal(s.total_chars, s.body_chars + s.history_chars, 'total is the exact sum');
    assert.equal(s.history_entries, 2);
    assert.equal(s.supersedes_count, 0);
    assert.equal(s.over_threshold, false, 'a small article is under the shipped threshold');
    assert.ok(s.oversize_threshold > 0, 'the verdict names the threshold it judged against');
  } finally {
    cleanup();
  }
});

test('knowledge_stats(): store-wide aggregate — per-type counts, total, largest articles flagged against the threshold', () => {
  const { tools, cleanup } = harness();
  try {
    mkArticle(tools, 'alpha', [{ date: NOW, event: 'seed' }]);
    mkArticle(tools, 'beta', [{ date: NOW, event: 'seed' }]);
    tools.knowledgeCreate('decision', {
      title: 'a ruling',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
      scope: 'project',
      stack_tags: [],
      links: [],
    });
    const agg = stats(tools)() as {
      by_type: Record<string, { count: number; body_chars: number }>;
      total_body_chars: number;
      oversize_threshold: number;
      largest_articles: { slug: string; body_chars: number; over_threshold: boolean }[];
    };
    assert.equal(agg.by_type.feature_article.count, 2);
    assert.equal(agg.by_type.decision.count, 1);
    assert.ok(agg.total_body_chars >= agg.by_type.feature_article.body_chars + agg.by_type.decision.body_chars);
    const slugs = agg.largest_articles.map((a) => a.slug).sort();
    assert.deepEqual(slugs, ['alpha', 'beta'], 'both articles appear in the largest list');
    assert.ok(agg.largest_articles.every((a) => a.over_threshold === false));
  } finally {
    cleanup();
  }
});
