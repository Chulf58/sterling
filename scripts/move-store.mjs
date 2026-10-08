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
//   node bin/move-store.mjs --to pg|sqlite [--dry-run] [--project <dir>]
//   node bin/move-store.mjs --to pg --confirm-fork [--dry-run] [--project <dir>]
//   node bin/move-store.mjs --attach [--fence-local] [--dry-run] [--project <dir>]
//
// --to pg and --attach are switched off (decision
// postgres-storage-switched-off-every-project-locked-to-local-sqlite): they refuse
// with MovePostgresOffError, before any file or connection is touched, unless
// STERLING_ALLOW_POSTGRES_MOVE=1 is set. --to sqlite is unaffected.
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
//
// Shared domains (decision
// shared-domains-stay-forked-and-loud-while-projects-move-one-at-a-time): --to pg
// fences a domain's SQLite file only when every other registered project that
// mounts it has config.storage postgres; a project still on SQLite, whatever its
// mode, keeps it writable (the fork), and a project whose config cannot be read
// counts as on SQLite and is named. A domain an earlier move already copied
// while its SQLite file stayed writable (fork_already_copied) is never copied
// again or merged: the run lists the records that will not reach Postgres and
// refuses until it is re-run with --confirm-fork.
//
// --attach is for a second machine with a fresh clone of a project already on
// Postgres (decision second-machine-attaches-to-a-postgres-project-through-move-store-attach).
// It copies nothing: it checks that the project schema and every mounted domain
// schema is registered, has a receipt and is not fenced, fences this machine's
// project SQLite file if there is one (a file holding records only with
// --fence-local), and then writes config.storage = postgres.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgBridge, ensurePgLayout, readPgCredentials, registryPath } from '../packages/store/dist/index.js';
import { routedCredentialsPath } from '../packages/store/dist/routing.js';
import {
  FORK_CONFIRM_FLAG,
  MOVE_BRIDGE_WAIT_MS,
  attachProject,
  describeForkLoss,
  ensureMoveReceipts,
  exportStore,
  importStore,
  planAttach,
  planMove,
  readRegisteredProjects,
  writeProjectStorage,
} from '../packages/store/dist/store-move.js';

const USAGE = [
  'usage: node bin/move-store.mjs --to pg|sqlite [--confirm-fork] [--dry-run] [--project <dir>]',
  '       node bin/move-store.mjs --attach [--fence-local] [--dry-run] [--project <dir>]',
].join('\n');

export class MoveStoreUsageError extends Error {
  constructor(message) {
    super(`${message}\n${USAGE}`);
    this.name = 'MoveStoreUsageError';
  }
}

export class MovePostgresOffError extends Error {
  constructor() {
    super(
      'Postgres storage is switched off (decision postgres-storage-switched-off-every-project-locked-to-local-sqlite). ' +
        'Nothing was read or written. --to sqlite still works. ' +
        'Set STERLING_ALLOW_POSTGRES_MOVE=1 only to deliberately reverse that decision.',
    );
    this.name = 'MovePostgresOffError';
  }
}

/** Refuses --to pg and --attach, dry run included, unless the env opts in with exactly '1'. --to sqlite is never refused. */
export function refusePostgresMove(args, env = process.env) {
  if ((args.attach || args.to === 'pg') && env.STERLING_ALLOW_POSTGRES_MOVE !== '1') throw new MovePostgresOffError();
}

/** A move returns { to, dryRun, project, confirmFork }; an attach returns { attach: true, fenceLocal, dryRun, project }. */
export function parseArgs(argv) {
  const out = { to: undefined, dryRun: false, project: undefined, confirmFork: false };
  let attach = false;
  let fenceLocal = false;
  let toGiven = false;
  // A flag's separate value: a missing one, or another option in its place, is refused rather than read as no value.
  const valueAfter = (i, need) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new MoveStoreUsageError(need);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') {
      toGiven = true;
      out.to = valueAfter(++i, '--to needs a value: pg or sqlite');
    } else if (a.startsWith('--to=')) {
      toGiven = true;
      out.to = a.slice(5);
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--project') out.project = valueAfter(++i, '--project needs a directory');
    else if (a.startsWith('--project=')) out.project = a.slice(10);
    else if (a === '--attach') attach = true;
    else if (a === '--fence-local') fenceLocal = true;
    else if (a === FORK_CONFIRM_FLAG) out.confirmFork = true;
    else throw new MoveStoreUsageError(`unknown argument '${a}'`);
  }
  if (out.project === '') throw new MoveStoreUsageError('--project needs a directory');
  if (attach) {
    if (toGiven) throw new MoveStoreUsageError('--attach copies nothing and takes no --to');
    if (out.confirmFork) throw new MoveStoreUsageError(`${FORK_CONFIRM_FLAG} is only for --to pg`);
    return { attach: true, fenceLocal, dryRun: out.dryRun, project: out.project };
  }
  if (fenceLocal) throw new MoveStoreUsageError('--fence-local is only for --attach');
  if (out.to !== 'pg' && out.to !== 'sqlite') throw new MoveStoreUsageError(`--to must be pg or sqlite, got ${out.to === undefined ? 'nothing' : `'${out.to}'`}`);
  if (out.confirmFork && out.to !== 'pg') throw new MoveStoreUsageError(`${FORK_CONFIRM_FLAG} is only for --to pg`);
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
 * between the receipts and the switch. `confirmFork` lets --to pg go past a
 * domain an earlier move already copied as a fork (FORK_CONFIRM_FLAG).
 */
export function runMoveStore({ root, to, dryRun = false, confirmFork = false, credentialsPath = routedCredentialsPath(), registryDb = registryPath(), hooks = {} }) {
  const direction = to === 'pg' ? 'to_postgres' : 'to_sqlite';
  const plan = planMove({ root, direction, registeredProjects: readRegisteredProjects(registryDb), credentialsPath });
  const report = { root: plan.root, direction, dryRun, metaSchema: plan.metaSchema, stores: [], failure: null, storageSwitched: false, storage: plan.storage, mode: plan.mode, skippedProjects: plan.skippedProjects, unreadableProjects: plan.unreadableProjects };
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
        confirmFork,
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

/**
 * Attaches this machine to a project already on Postgres. Throws the named
 * refusals (planMove's, MoveAttachError, MoveSourceFencedError); the file
 * checks run before any connection opens.
 */
export function runAttach({ root, dryRun = false, fenceLocal = false, credentialsPath = routedCredentialsPath() }) {
  const plan = planAttach({ root, credentialsPath, fenceLocal });
  const bridge = new PgBridge(readPgCredentials(credentialsPath), { waitTimeoutMs: MOVE_BRIDGE_WAIT_MS });
  try {
    return attachProject(plan, bridge, { dryRun });
  } finally {
    bridge.close();
  }
}

const LOCAL_ACTION = {
  absent: 'none on this machine',
  fenced: 'fenced',
  already_fenced: 'already fenced toward the project schema',
  would_fence: 'would be fenced (dry run fences nothing)',
};

export function formatAttachReport(report) {
  const lines = [`move-store --attach ${report.dryRun ? '(dry run) ' : ''}for ${report.root}: no data is copied`];
  for (const s of report.stores) {
    lines.push(`${s.identity.kind} ${s.identity.name}: postgres:${s.schema} registered, not fenced; receipt ${s.receipt.move_id} from ${s.receipt.source} at ${s.receipt.committed_at}`);
  }
  const held = report.local.occupied.length ? `holds ${report.local.occupied.join(', ')}` : 'holds nothing';
  const records = report.local.action === 'absent' ? '' : ` (${held}; kept in the file, not read while storage is postgres)`;
  lines.push(`local project SQLite ${report.local.path}: ${LOCAL_ACTION[report.local.action]}${records}`);
  lines.push(report.dryRun ? 'config.storage not changed (dry run)' : 'config.storage switched to postgres');
  lines.push(`config.mode unchanged (${report.mode})`);
  return lines.join('\n');
}

export function formatReport(report) {
  const lines = [`move-store ${report.dryRun ? '(dry run) ' : ''}${report.direction === 'to_postgres' ? 'SQLite -> Postgres' : 'Postgres -> SQLite'} for ${report.root}`];
  for (const s of report.stores) {
    lines.push(`${s.identity.kind} ${s.identity.name}: ${s.source} -> ${s.target}`);
    lines.push(`  outcome: ${s.outcome}${s.dry_run_plan ? ` (would: ${s.dry_run_plan})` : ''}; move ${s.move_id}`);
    lines.push(`  hash match: ${s.outcome === 'dry_run' ? 'not checked (dry run)' : s.hash_match ? 'yes' : 'no'}; manifest ${s.manifest_digest.slice(0, 16)}`);
    lines.push(`  ids per table: ${Object.entries(s.tables).filter(([, t]) => t.rows > 0).map(([n, t]) => `${n} ${t.rows}`).join(', ') || 'none (empty store)'}`);
    if (s.sharedWith.length) {
      const holders = s.sharedWith.map((h) => `${h.root} (${h.mode === null ? 'config unreadable, counted as on SQLite' : report.direction === 'to_postgres' ? `${h.mode}, storage ${h.storage}` : h.mode})`).join(', ');
      lines.push(
        report.direction === 'to_postgres'
          ? `  shared domain, NOT fenced: its SQLite copy stays writable for ${holders}; the two copies diverge from this move on`
          : `  shared domain, NOT fenced: its Postgres copy stays live for ${holders}; the two copies diverge from this move on`,
      );
    } else {
      lines.push(`  source fenced: ${s.source_fenced ? 'yes' : report.dryRun ? 'no (dry run fences nothing)' : 'no'}`);
    }
    if (s.fork_loss) lines.push(`  already forked, NOT copied again (${FORK_CONFIRM_FLAG}); nothing below carries over: ${describeForkLoss(s.fork_loss)}`);
  }
  if (report.unreadableProjects.length) {
    lines.push(`registered projects whose config cannot be read, counted as on SQLite and mounting every domain (no shared domain fenced for them):`);
    for (const u of report.unreadableProjects) lines.push(`  ${u.root}: ${u.reason}`);
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
    refusePostgresMove(args);
  } catch (e) {
    process.stderr.write(`move-store: ${e instanceof MovePostgresOffError ? `${e.name}: ` : ''}${e.message}\n`);
    process.exit(2);
  }
  try {
    const root = findProjectRoot(args.project ?? process.cwd());
    if (args.attach) {
      process.stdout.write(formatAttachReport(runAttach({ root, dryRun: args.dryRun, fenceLocal: args.fenceLocal })) + '\n');
      process.exit(0);
    }
    const report = runMoveStore({ root, to: args.to, dryRun: args.dryRun, confirmFork: args.confirmFork });
    process.stdout.write(formatReport(report) + '\n');
    process.exit(report.failure ? 1 : 0);
  } catch (e) {
    process.stderr.write(`move-store: ${e?.name ?? 'Error'}: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}

// Run as the source or as bin/move-store.mjs. Bundled into bin/, this module's
// import.meta.url is rewritten to name this scripts/ source (source-location
// identity, scripts/lib/bundled-artifacts.mjs), so the bin path is named too.
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs === fileURLToPath(import.meta.url) || launchedAs === fileURLToPath(new URL('../bin/move-store.mjs', import.meta.url))) main();
