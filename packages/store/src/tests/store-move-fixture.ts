// Fixture stores for the store-move tests (store-move.test.ts and
// scripts/tests/move-store.test.mjs). Every store is a SQLite file in a temp
// directory, opened with an explicit SqliteDriver so the Postgres driver
// factory the full suite installs (pg-test-setup.ts) never redirects it.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore } from '../index.js';
import { SqliteDriver } from '../sqlite-driver.js';

export const NOW = '2026-10-06T08:00:00.000Z';

export function envelope(type: string) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [] as { rel: string; target_id: string }[], scope: 'project', stack_tags: ['node'] };
}

export function decision(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'Use SQLite',
    statement: 'SQLite is the storage substrate.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'Meets all retrieval criteria.',
    file_keys: ['packages/store/src/index.ts'],
    ...over,
  };
}

export function article(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as a CSV file for spreadsheets.',
    intended_behavior: 'User clicks Export and receives a CSV download.',
    files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

export function systemTodo(over: Record<string, unknown> = {}) {
  return { ...envelope('todo'), author: 'system', stack_tags: [], text: 're-verify finding', source: 'system', system_reason: 'stale_research', feature_link: randomUUID(), ...over };
}

export function openSqliteStore(path: string): SterlingStore {
  mkdirSync(dirname(path), { recursive: true });
  return new SterlingStore(path, { driver: new SqliteDriver(path) });
}

export interface SeedOptions {
  /** A label carried into titles and slugs, so two fixture stores never share content. */
  label: string;
  /** Extra plain decisions, for bulk and throughput runs. */
  bulk?: number;
  /** Put a U+0000 into a decision's statement (inside the JSON body only). */
  nulInBody?: boolean;
}

export interface Seeded {
  /** Every live record id. */
  ids: string[];
  /** The decision whose statement holds U+0000, when nulInBody. */
  nulId?: string;
  /** An alias historical_id inserted raw. */
  aliasId: string;
}

/**
 * Fills every copied table: records with relations, stack tags and file keys;
 * a superseded decision (record_versions, a supersedes relation); an updated
 * article (another version); a drained system todo (queue_drain_log); the
 * activity log; store_meta; and one record_aliases row inserted raw.
 */
export function seedStore(path: string, opts: SeedOptions): Seeded {
  const store = openSqliteStore(path);
  const ids: string[] = [];
  let nulId: string | undefined;
  try {
    store.setMeta('description', `fixture store ${opts.label}`);
    const a = store.create(decision({ title: `${opts.label} first decision` }));
    const b = store.create(decision({ title: `${opts.label} cites the first`, links: [{ rel: 'cites', target_id: a.id }], stack_tags: ['node', 'typescript'] }));
    const a2 = store.supersede(a.id, decision({ title: `${opts.label} first decision, revised` }));
    const artInput = article({ slug: `fixture-${opts.label}`, title: `${opts.label} article` });
    const art = store.create(artInput);
    store.updateRecord(art.id, { ...artInput, what_it_does: 'Exports the board, revised.' });
    const sys = store.enqueueSystemTodo(systemTodo({ text: `${opts.label} queue item` }));
    store.remove(sys.record.id, NOW);
    ids.push(a.id, b.id, a2.id, art.id);
    if (opts.nulInBody) {
      const n = store.create(decision({ title: `${opts.label} holds a NUL`, statement: 'before\u0000after' }));
      nulId = n.id;
      ids.push(n.id);
    }
    const bulk = opts.bulk ?? 0;
    for (let start = 0; start < bulk; start += 500) {
      store.withTransaction(() => {
        for (let i = start; i < Math.min(bulk, start + 500); i++) {
          ids.push(store.create(decision({ title: `${opts.label} bulk decision ${i}`, statement: `Bulk statement ${i}: ${'lorem ipsum dolor sit amet '.repeat(20)}` })).id);
        }
      });
    }
  } finally {
    store.close();
  }
  const aliasId = randomUUID();
  const raw = new DatabaseSync(path);
  try {
    raw.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)').run(aliasId, ids[1], NOW);
  } finally {
    raw.close();
  }
  return { ids, nulId, aliasId };
}
