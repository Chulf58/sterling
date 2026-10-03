// The files[].entry flag (decision feature-article-states-follow-the-spec-meaning):
// an article marks the file a registry reaches, and the read-time state check
// looks that file up. The flag is an optional boolean like `unverified`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { featureArticleSchema, schemaFor, SYSTEM_REASONS, DRAIN_VERBS } from '../index.js';

const NOW = '2026-10-03T00:00:00.000Z';

const article = (files: unknown[]) => ({
  id: randomUUID(),
  type: 'feature_article',
  created_at: NOW,
  updated_at: NOW,
  author: 'conductor',
  lifecycle: 'live',
  freshness: 'fresh',
  links: [],
  scope: 'project',
  stack_tags: [],
  slug: 'drain',
  title: 'drain',
  what_it_does: 'x',
  intended_behavior: 'x',
  files,
  current_ac: [],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [{ date: NOW, event: 'seed' }],
  live_test_refs: [],
  status: 'active',
  superseded_by: null,
});

test('files[].entry accepts a boolean and is optional', () => {
  const parsed = featureArticleSchema.parse(
    article([
      { path: 'skills/drain/SKILL.md', role: 'the SOP', entry: true },
      { path: 'commands/drain.md', role: 'the command' },
    ])
  ) as { files: { entry?: boolean }[] };
  assert.equal(parsed.files[0].entry, true);
  assert.equal(parsed.files[1].entry, undefined);
});

test('files[].entry refuses a non-boolean', () => {
  const res = featureArticleSchema.safeParse(article([{ path: 'skills/drain/SKILL.md', role: 'the SOP', entry: 'yes' }]));
  assert.equal(res.success, false);
});

test('knowledge_schema reports entry as an optional boolean files[] sub-field', () => {
  const files = schemaFor('feature_article')?.fields.find((f) => f.name === 'files');
  const entry = files?.element_fields?.find((f) => f.name === 'entry');
  assert.ok(entry, 'entry is listed among files[] element fields');
  assert.equal(entry.type, 'boolean');
  assert.equal(entry.required, false);
});

test('wire_in_dormant is gone from the queue reasons and the drain verbs', () => {
  assert.equal((SYSTEM_REASONS as readonly string[]).includes('wire_in_dormant'), false);
  assert.equal('wire_in_dormant' in DRAIN_VERBS, false);
  assert.ok((SYSTEM_REASONS as readonly string[]).includes('state_review'), 'state_review stays');
});
