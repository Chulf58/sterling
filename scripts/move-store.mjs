#!/usr/bin/env node
// move-store: move the invoking project's knowledge store, with its mounted
// domain stores, from SQLite to Postgres (--to pg) or back (--to sqlite).
// Issue Chulf58/sterling#26 items 6 and 8; decisions
// postgres-importer-write-fence-batched-copy-shared-domains-fork and
// store-move-skill-two-way-one-direction-at-a-time-no-live-sync. One run moves
// only the project it runs in (user-ruled 2026-10-06, "Drop --all: project
// only"); the machine registry is read only to find other projects that share
// a domain, never to move them.
//
//   node scripts/move-store.mjs --to pg|sqlite [--dry-run] [--project <dir>]
//
// Refuses by name: a directory with no Sterling config, --to pg in a hobby
// project, a missing .sterling/project.json, missing or invalid Postgres
// credentials. Every store is checked first, so a refusal anywhere moves and
// fences nothing. Then each store is fenced on the side it leaves, copied,
// verified against a content-hash manifest and given a receipt
// (packages/store/src/store-move.ts). config.storage (decision
// storage-backend-is-its-own-config-key-written-only-by-store-move) is written
// only after every store's receipt has committed; config.mode is never
// touched. A re-run after a crash replays the receipts and completes the switch.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgBridge, ensurePgLayout, readPgCredentials, registryPath } from '../packages/store/dist/index.js';
import { routedCredentialsPath } from '../packages/store/dist/routing.js';
import {
  MOVE_BRIDGE_WAIT_MS,
  ensureMoveReceipts,
  exportStore,
  importStore,
  planMove,
  readRegisteredProjects,
  writeProjectStorage,
} from '../packages/store/dist/store-move.js';

const USAGE = 'usage: node scripts/move-store.mjs --to pg|sqlite [--dry-run] [--project <dir>]';

export class MoveStoreUsageError extends Error {
  constructor(message) {
    super(`${message}\n${USAGE}`);
    this.name = 'MoveStoreUsageError';
  }
}

export function parseArgs(argv) {
  const out = { to: undefined, dryRun: false, project: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--project') out.project = argv[++i];
    else if (a.startsWith('--project=')) out.project = a.slice(10);
    else throw new MoveStoreUsageError(`unknown argument '${a}'`);
  }
  if (out.to !== 'pg' && out.to !== 'sqlite') throw new MoveStoreUsageError(`--to must be pg or sqlite, got ${out.to === undefined ? 'nothing' : `'${out.to}'`}`);
  if (out.project === '') throw new MoveStoreUsageError('--project needs a directory');
  return out;
}

/** The nearest directory at or above `start` holding .sterling/config.json, or `start` itself (planMove then refuses by name). */
export function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.sterling', 'config.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

/**
 * Moves one project's stores. Throws the planner's named refusals before any
 * connection opens. Every store is classified read-only first; a refusal
 * there is returned in `failure` before anything is fenced. A store failure
 * during the move stops the run, is returned in `failure`, and withholds the
 * storage switch. `hooks.beforeStorageSwitch` is the test seam for a crash
 * between the receipts and the switch.
 */
export function runMoveStore({ root, to, dryRun = false, credentialsPath = routedCredentialsPath(), registryDb = registryPath(), hooks = {} }) {
  const direction = to === 'pg' ? 'to_postgres' : 'to_sqlite';
  const plan = planMove({ root, direction, registeredProjects: readRegisteredProjects(registryDb), credentialsPath });
  const report = { root: plan.root, direction, dryRun, metaSchema: plan.metaSchema, stores: [], failure: null, storageSwitched: false, storage: plan.storage, mode: plan.mode, skippedProjects: plan.skippedProjects };
  const bridge = new PgBridge(readPgCredentials(credentialsPath), { waitTimeoutMs: MOVE_BRIDGE_WAIT_MS });
  try {
    if (!dryRun) {
      ensurePgLayout(bridge, plan.metaSchema);
      ensureMoveReceipts(bridge, plan.metaSchema);
    }
    const move = (store, dry) => {
      const input = {
        bridge,
        metaSchema: plan.metaSchema,
        schema: store.schema,
        sqlitePath: store.sqlitePath,
        identity: store.identity,
        fenceSource: store.fenceSource,
        forkedWith: store.forkedWith.map((h) => h.root),
        dryRun: dry,
      };
      return direction === 'to_postgres' ? importStore(input) : exportStore(input);
    };
    const fail = (store, e) => {
      report.failure = { identity: store.identity, name: e?.name ?? 'Error', message: String(e?.message ?? e) };
    };
    // Read-only pass over every store: a refusal anywhere stops the run before any store is fenced.
    const checked = [];
    for (const store of plan.stores) {
      try {
        const result = move(store, true);
        if (result.dry_run_refusal) {
          fail(store, result.dry_run_refusal);
          break;
        }
        checked.push({ ...result, sharedWith: store.sharedWith });
      } catch (e) {
        fail(store, e);
        break;
      }
    }
    if (dryRun) {
      report.stores = checked;
    } else if (report.failure === null) {
      for (const store of plan.stores) {
        try {
          report.stores.push({ ...move(store, false), sharedWith: store.sharedWith });
        } catch (e) {
          fail(store, e);
          break;
        }
      }
    }
    if (!dryRun && report.failure === null) {
      hooks.beforeStorageSwitch?.(report);
      const storage = direction === 'to_postgres' ? 'postgres' : 'sqlite';
      report.storageSwitched = writeProjectStorage(plan.root, storage);
      report.storage = storage;
    }
  } finally {
    bridge.close();
  }
  return report;
}

export function formatReport(report) {
  const lines = [`move-store ${report.dryRun ? '(dry run) ' : ''}${report.direction === 'to_postgres' ? 'SQLite -> Postgres' : 'Postgres -> SQLite'} for ${report.root}`];
  for (const s of report.stores) {
    lines.push(`${s.identity.kind} ${s.identity.name}: ${s.source} -> ${s.target}`);
    lines.push(`  outcome: ${s.outcome}${s.dry_run_plan ? ` (would: ${s.dry_run_plan})` : ''}; move ${s.move_id}`);
    lines.push(`  hash match: ${s.outcome === 'dry_run' ? 'not checked (dry run)' : s.hash_match ? 'yes' : 'no'}; manifest ${s.manifest_digest.slice(0, 16)}`);
    lines.push(`  ids per table: ${Object.entries(s.tables).filter(([, t]) => t.rows > 0).map(([n, t]) => `${n} ${t.rows}`).join(', ') || 'none (empty store)'}`);
    if (s.sharedWith.length) {
      const holders = s.sharedWith.map((h) => `${h.root} (${h.mode})`).join(', ');
      lines.push(
        report.direction === 'to_postgres'
          ? `  shared domain, NOT fenced: its SQLite copy stays writable for ${holders}; the two copies diverge from this move on`
          : `  shared domain, NOT fenced: its Postgres copy stays live for ${holders}; the two copies diverge from this move on`,
      );
    } else {
      lines.push(`  source fenced: ${s.source_fenced ? 'yes' : report.dryRun ? 'no (dry run fences nothing)' : 'no'}`);
    }
  }
  if (report.skippedProjects.length) lines.push(`registered projects skipped in the shared-domain check (directory or config gone): ${report.skippedProjects.join(', ')}`);
  if (report.failure) {
    lines.push(`FAILED on ${report.failure.identity.kind} ${report.failure.identity.name}: ${report.failure.name}: ${report.failure.message}`);
    lines.push('config.storage was not changed. Fix the cause and re-run; finished stores replay from their receipts.');
  } else if (!report.dryRun) {
    lines.push(report.storageSwitched ? `config.storage switched to ${report.storage}` : `config.storage already ${report.storage}`);
    lines.push(`config.mode unchanged (${report.mode})`);
  }
  return lines.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`move-store: ${e.message}\n`);
    process.exit(2);
  }
  try {
    const report = runMoveStore({ root: findProjectRoot(args.project ?? process.cwd()), to: args.to, dryRun: args.dryRun });
    process.stdout.write(formatReport(report) + '\n');
    process.exit(report.failure ? 1 : 0);
  } catch (e) {
    process.stderr.write(`move-store: ${e?.name ?? 'Error'}: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
