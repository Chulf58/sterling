// TEST HELPER, not a test file (the runner globs *.test.js). Builds the
// pre-ruling raw supersedes edge: a record_relations row whose target stays
// ACTIVE. knowledge_create and knowledge_update admitted that edge before
// decision a-supersedes-link-on-create-or-update-is-refused-use-knowledge-supersede,
// and stores still hold such edges, so tests of how they are read and delivered
// need one. No store method writes it any more; this inserts the row directly
// through the holding store's db handle. Imported by tests in store,
// mcp-server, tui and scripts/tests, never by shipped code.
import type { SterlingStore, MountedStores } from '../index.js';

type Db = { prepare(sql: string): { run(...args: unknown[]): unknown } };

function holdingStore(store: SterlingStore | MountedStores, id: string): SterlingStore {
  // MountedStores keeps its mounts behind a private all(); a bare SterlingStore
  // is its own only candidate.
  const all = (store as unknown as { all?: () => SterlingStore[] }).all;
  const candidates = typeof all === 'function' ? all.call(store) : [store as SterlingStore];
  const holders = candidates.filter((s) => s.get(id) !== undefined);
  if (holders.length !== 1) {
    throw new Error(`seedLegacySupersedesEdge: expected exactly one store holding '${id}', found ${holders.length}`);
  }
  return holders[0];
}

export function seedLegacySupersedesEdge(store: SterlingStore | MountedStores, sourceId: string, targetId: string): void {
  if (sourceId === targetId) throw new Error(`seedLegacySupersedesEdge: '${sourceId}' cannot supersede itself`);
  if (!store.get(targetId)) throw new Error(`seedLegacySupersedesEdge: no target record '${targetId}'`);
  const holder = holdingStore(store, sourceId);
  (holder as unknown as { db: Db }).db
    .prepare('INSERT INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceId, 'supersedes', targetId, new Date().toISOString());
}
