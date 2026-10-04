import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { featureArticleSchema, NOT_APPLICABLE_EXEMPT_KINDS } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';

// GitHub issue #15: knowledge_schema typed current_ac and live_test_refs as
// `{...}[] | {not_applicable}` with no condition, while knowledge_create refuses
// the {not_applicable} form on every article_kind except the exempt ones
// (decision article-kind-marker-gates-structured-na-exemption). The schema
// output must name exactly the kinds the validator accepts.

const NOW = '2026-06-10T12:00:00.000Z';
const GATED_FIELDS = ['current_ac', 'live_test_refs'] as const;

function describeType(type: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-schema-na-cond-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    return new SterlingTools({ store, now: () => NOW }).knowledgeSchema(type);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function exemptArticle(articleKind: string) {
  const exemption = { not_applicable: { reason: 'nothing to test here' } };
  return {
    id: randomUUID(),
    type: 'feature_article',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    slug: 'probe-alpha',
    title: 'Probe Alpha',
    what_it_does: 'Investigates a claim.',
    intended_behavior: 'Verifies one claim.',
    files: [],
    article_kind: articleKind,
    current_ac: exemption,
    dependencies: { relies_on: [], relied_by: [] },
    state: 'planned',
    version: 1,
    history: [{ date: NOW, event: 'created' }],
    live_test_refs: exemption,
  };
}

function mentionedKinds(text: string, kinds: readonly string[]): string[] {
  return kinds.filter((k) => new RegExp(`\\b${k}\\b`).test(text));
}

test('knowledge_schema feature_article: current_ac and live_test_refs carry a condition naming exactly the article_kind values the validator accepts for {not_applicable}', () => {
  const described = describeType('feature_article');
  const allKinds = described.fields.find((f) => f.name === 'article_kind')?.enum_values ?? [];
  assert.ok(allKinds.length >= 4, 'article_kind enum is reported');

  // The oracle is the validator itself: try each kind with the exemption on both fields.
  const accepted = allKinds.filter((k) => featureArticleSchema.safeParse(exemptArticle(k)).success);
  assert.ok(accepted.length > 0 && accepted.length < allKinds.length, 'some kinds accept and some refuse the exemption');
  assert.deepEqual([...accepted].sort(), [...NOT_APPLICABLE_EXEMPT_KINDS].sort(), 'the exported constant is what the validator accepts');

  for (const name of GATED_FIELDS) {
    const condition = described.fields.find((f) => f.name === name)?.condition;
    assert.equal(typeof condition, 'string', `${name} has a condition`);
    assert.match(condition!, /not_applicable/, `${name} condition names the exemption`);
    // The accepted kinds are named before the "other kinds" clause; the refused kinds only in it.
    const [allowedClause, otherClause] = condition!.split(/other kinds/i);
    assert.ok(otherClause, `${name}: condition has an other-kinds clause`);
    assert.deepEqual(mentionedKinds(allowedClause, allKinds).sort(), [...accepted].sort(), `${name}: allowed clause names exactly the accepted kinds`);
    assert.deepEqual(
      mentionedKinds(otherClause, allKinds).sort(),
      allKinds.filter((k) => !accepted.includes(k)).sort(),
      `${name}: other-kinds clause names exactly the refused kinds`
    );
  }
});

test('knowledge_schema feature_article: the live_test_refs condition says [] is allowed for the non-exempt kinds', () => {
  const condition = describeType('feature_article').fields.find((f) => f.name === 'live_test_refs')?.condition;
  assert.match(condition!, /\[\]/);
});

// These two pinned "no other field has any condition". Other rules now print
// conditions too (schema-enforced-rules.test.ts), so the pins are narrowed to
// what they were guarding: the article_kind rule sits on these two fields only.
test('knowledge_schema feature_article: only current_ac and live_test_refs carry the article_kind condition', () => {
  const withCondition = describeType('feature_article')
    .fields.filter((f) => /not_applicable/.test(f.condition ?? ''))
    .map((f) => f.name)
    .sort();
  assert.deepEqual(withCondition, ['current_ac', 'live_test_refs']);
});

test('knowledge_schema: record types other than feature_article report no article_kind condition', () => {
  for (const type of ['decision', 'anti_pattern', 'research_finding']) {
    assert.ok(describeType(type).fields.every((f) => !/not_applicable|article_kind/.test(f.condition ?? '')), `${type} has no article_kind condition`);
  }
});

test('the validator refusal names the same exempt kinds as the exported constant', () => {
  const result = featureArticleSchema.safeParse(exemptArticle('feature'));
  assert.equal(result.success, false);
  const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
  for (const kind of NOT_APPLICABLE_EXEMPT_KINDS) assert.match(message, new RegExp(`\\b${kind}\\b`));
});
