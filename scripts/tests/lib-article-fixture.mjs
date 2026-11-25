// Shared fixture for the fs-move / fs-remove worktree tests.
import { randomUUID } from 'node:crypto';

const NOW = '2026-06-10T12:00:00.000Z';

export function article(slug, path) {
  return {
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    files: [{ path, role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'originating brief' }], live_test_refs: [],
  };
}
