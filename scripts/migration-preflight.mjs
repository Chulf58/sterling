// scripts/migration-preflight.mjs — read-only preflight report for the
// stable-identity schema-v2 cutover (S1, decision stable-identity-design-v2 /
// 2176748e). NEVER writes to the target store: opens it read-only
// (node:sqlite DatabaseSync {readOnly:true}) so a human can review the shape
// of what the migration runner (a later slice) will touch before anything is
// touched. Registered in config.store_guard.allow_scripts
// (packages/schemas/src/config.ts) so H15 does not flag this sanctioned,
// read-only script the way it would flag ad-hoc store access.
//
//   node scripts/migration-preflight.mjs --db <path-to-sterling.db>
//
// JSON stdout contract, field definitions ("chain", "depth", "historical id",
// "prefix collision") and the fixture they are pinned against all live in
// scripts/tests/migration-preflight.test.mjs — that file is the authoritative
// oracle; this comment is a pointer, not the spec.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The version the (later-slice) migration runner will STAMP once it has run —
// i.e. one past packages/store's current SUPPORTED_SCHEMA_VERSION (1), not a
// mirror of it. A store already at or past this version has nothing left to
// preflight.
const MIGRATED_SCHEMA_VERSION = 2;

function fail(msg, code = 2) {
  console.error(`migration-preflight: ${msg}`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const dbPath = arg('db');
  if (!dbPath) return fail('--db <path-to-sterling.db> is required');
  if (!existsSync(dbPath)) return fail(`no db file at '${dbPath}'`);

  // Open failures (a hot -wal a reader can't recover, an unwritable dir for
  // the -shm sidecar, …) fail with the same formatted prefix as every other
  // failure here, not a raw uncaught-exception stack trace (fixer-mode F3a).
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return fail(`could not open '${dbPath}': ${e.message}`);
  }

  try {
    // One read transaction over EVERY read below (user_version + records +
    // record_links) so the report is a single consistent snapshot under WAL,
    // never a mix of pre/post-write state from a concurrent writer
    // (fixer-mode F3c). A plain (deferred) BEGIN needs no write lock — this
    // connection is read-only and never executes a write statement.
    db.exec('BEGIN');
    let report;
    try {
      const userVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (userVersion >= MIGRATED_SCHEMA_VERSION) {
        report = { already_migrated: true, user_version: userVersion };
      } else {
        const records = db.prepare('SELECT id, type, status FROM records').all();
        const byId = new Map(records.map((r) => [r.id, r]));

        // superseded_by_type + historical_id_count: every superseded record,
        // grouped by type — the "historical (non-terminus) id" set (every
        // superseded record is, by definition, not the terminus of its lineage).
        const superseded_by_type = {};
        let historical_id_count = 0;
        for (const r of records) {
          if (r.status !== 'superseded') continue;
          historical_id_count++;
          superseded_by_type[r.type] = (superseded_by_type[r.type] ?? 0) + 1;
        }

        // record_links edges (the links[] materialization — see packages/store's
        // insertRecord). links_targeting_superseded/missing count EVERY edge
        // regardless of rel; chains below are built from rel:'supersedes' edges
        // only. The plain superseded_by scalar (retireInFavorOf's duplicate path)
        // is deliberately NOT a links[] edge and contributes to neither count.
        const links = db.prepare('SELECT source_id, rel, target_id FROM record_links').all();
        let links_targeting_superseded = 0;
        let links_targeting_missing = 0;
        for (const l of links) {
          const target = byId.get(l.target_id);
          if (!target) links_targeting_missing++;
          else if (target.status === 'superseded') links_targeting_superseded++;
        }

        // chains: weakly-connected components over the supersedes-only edge
        // subgraph. depth = number of NODES in the component (an A->B->C chain,
        // all three linked via supersede(), is depth 3). A record with no
        // supersedes edge (e.g. a retireInFavorOf duplicate) never enters this
        // graph, so it forms no chain of its own.
        const adjacency = new Map();
        const addEdge = (a, b) => {
          if (!adjacency.has(a)) adjacency.set(a, new Set());
          if (!adjacency.has(b)) adjacency.set(b, new Set());
          adjacency.get(a).add(b);
          adjacency.get(b).add(a);
        };
        for (const l of links) {
          if (l.rel === 'supersedes') addEdge(l.source_id, l.target_id);
        }
        const visited = new Set();
        const depths = [];
        for (const node of adjacency.keys()) {
          if (visited.has(node)) continue;
          const stack = [node];
          const component = new Set();
          while (stack.length) {
            const n = stack.pop();
            if (component.has(n)) continue;
            component.add(n);
            visited.add(n);
            for (const neighbor of adjacency.get(n) ?? []) {
              if (!component.has(neighbor)) stack.push(neighbor);
            }
          }
          depths.push(component.size);
        }
        const depth_distribution = {};
        for (const d of depths) depth_distribution[d] = (depth_distribution[d] ?? 0) + 1;

        // prefix_collisions: distinct 8-char id-prefix GROUPS shared by 2+ ids,
        // over every id currently in the store — current (active) and historical
        // (superseded) alike.
        const prefixCounts = new Map();
        for (const r of records) {
          const prefix = r.id.slice(0, 8);
          prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
        }
        let prefix_collisions = 0;
        for (const count of prefixCounts.values()) {
          if (count >= 2) prefix_collisions++;
        }

        report = {
          superseded_by_type,
          chains: {
            count: depths.length,
            max_depth: depths.length ? Math.max(...depths) : 0,
            depth_distribution,
          },
          links_targeting_superseded,
          links_targeting_missing,
          historical_id_count,
          prefix_collisions,
        };
      }
    } finally {
      // Read-only transaction — COMMIT and ROLLBACK are equivalent here since
      // nothing was written; COMMIT is the natural close for a read snapshot.
      db.exec('COMMIT');
    }
    // No forced exit after output (fixer-mode F3b): a forced process.exit can
    // truncate a piped stdout write. Falling through to `finally` lets
    // db.close() run and stdout flush naturally; the process then exits 0 on
    // its own.
    console.log(JSON.stringify(report));
  } finally {
    db.close();
  }
}

main();
