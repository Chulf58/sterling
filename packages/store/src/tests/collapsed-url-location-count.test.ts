// SterlingStore.countCollapsedUrlLocations: the read-only count of
// reference_material records whose URL location lost its second slash to path
// normalization (issue #14). It measures existing damage and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-10-04T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-collapsed-url-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ref = (kind: 'doc' | 'url' | 'pdf', location: string): Record<string, unknown> => ({
  id: randomUUID(),
  type: 'reference_material',
  created_at: NOW,
  updated_at: NOW,
  author: 'conductor',
  status: 'active',
  superseded_by: null,
  links: [],
  scope: 'project',
  stack_tags: [],
  title: `ref ${location}`,
  kind,
  location,
  summary: 's',
  source_date: '2026-10-04',
  capture_date: '2026-10-04',
});

test('an empty store counts zero', () => {
  const { store, cleanup } = harness();
  try {
    assert.equal(store.countCollapsedUrlLocations(), 0);
  } finally {
    cleanup();
  }
});

test('only collapsed URL locations are counted, whatever the kind; intact URLs, paths, drive paths and prose are not', () => {
  const { store, cleanup } = harness();
  try {
    store.create(ref('doc', 'https:/example.com/docs/spec'));
    store.create(ref('url', 'http:/example.com/other'));
    store.create(ref('doc', 'https://example.com/docs/spec'));
    store.create(ref('url', 'https://example.com/other'));
    store.create(ref('doc', 'docs/spec.md'));
    store.create(ref('doc', 'c:/docs/spec.md'));
    store.create(ref('doc', 'the portal, mirrored at https:/example.com'));
    assert.equal(store.countCollapsedUrlLocations(), 2);
  } finally {
    cleanup();
  }
});

test('the count is read-only: no record version or timestamp moves', () => {
  const { store, cleanup } = harness();
  try {
    const created = store.create(ref('doc', 'https:/example.com/docs/spec')) as unknown as { id: string };
    const before = JSON.stringify(store.get(created.id));
    store.countCollapsedUrlLocations();
    assert.equal(JSON.stringify(store.get(created.id)), before);
  } finally {
    cleanup();
  }
});

test('a write stores an intact URL verbatim, so a repaired record leaves the count', () => {
  const { store, cleanup } = harness();
  try {
    const created = store.create(ref('doc', 'https://example.com/docs/spec')) as unknown as { location: string };
    assert.equal(created.location, 'https://example.com/docs/spec');
    assert.equal(store.countCollapsedUrlLocations(), 0);
  } finally {
    cleanup();
  }
});
