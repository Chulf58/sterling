import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { featureArticleSchema, RECORD_TYPES } from '../index.js';

const NOW = '2026-09-20T12:00:00.000Z';
const absence = { attested_at: NOW, item_id: randomUUID(), head_commit: 'a'.repeat(40) };

const envelope = (type: string) => ({
  id: randomUUID(),
  type,
  created_at: NOW,
  updated_at: NOW,
  author: 'conductor',
  status: 'active',
  superseded_by: null,
  links: [],
  scope: 'project',
  stack_tags: ['sterling'],
});

test('absence_attestations is shared byte-free provenance on both baseline-bearing record types', () => {
  const article = featureArticleSchema.parse({
    ...envelope('feature_article'),
    slug: 'absence-proof',
    title: 'absence proof',
    what_it_does: 'records an exact tree miss',
    intended_behavior: 'never invents bytes for absence',
    files: [{ path: 'docs/gone.md', role: 'subject' }],
    current_ac: [{ ac_id: 'AC1', text: 'absence is durable provenance', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    absence_attestations: { 'docs/gone.md': absence },
  }) as unknown as { absence_attestations: Record<string, unknown> };
  assert.deepEqual(article.absence_attestations['docs/gone.md'], absence);

  const reference = RECORD_TYPES.reference_material.schema.parse({
    ...envelope('reference_material'),
    title: 'gone reference',
    kind: 'doc',
    location: 'docs/gone.md',
    summary: 'the document is absent from HEAD',
    source_date: '2026-09-20',
    capture_date: '2026-09-20',
    absence_attestations: { 'docs/gone.md': absence },
  }) as unknown as { absence_attestations: Record<string, unknown> };
  assert.deepEqual(reference.absence_attestations['docs/gone.md'], absence);
});

test('an absence attestation refuses byte-shaped fields rather than silently dropping them', () => {
  const record = {
    ...envelope('feature_article'),
    slug: 'absence-shape',
    title: 'absence shape',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'docs/gone.md', role: 'subject' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    absence_attestations: { 'docs/gone.md': { ...absence, sha256: 'not-a-real-absence' } },
  };
  assert.throws(() => featureArticleSchema.parse(record), /Unrecognized key.*sha256/i);
});
