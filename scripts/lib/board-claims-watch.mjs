// Cross-project expired-claim reader (slice 4 of the multi-session toolkit; decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). Ported in behaviour from CH.Hub's
// scripts/lib/board-claims-watch.mjs: every registered project is read in its OWN bounded child
// process, and a timed-out, unreadable or unsupported board is reported DEGRADED, never as an empty
// board. Each board is read through Sterling's read-only readForeignBoard (no raw SQLite reader, no
// SterlingStore) and judged by boardClaimView with that project's own board_claims.lease_minutes.
// The reader never renews, takes over or writes anything.
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { registryPath, readRegistrySnapshotReadOnly, readForeignBoard, boardClaimView, SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { resolveStoreRoute } from '@sterling/store/routing';
import { boardDisplayLabel } from '@sterling/schemas';

export const CLAIM_READ_TIMEOUT_MS = 5_000;
const MAX_RESULT_BYTES = 1024 * 1024;

function degraded(project, root, reason) {
  return { project, root, degraded: true, reason };
}

/**
 * Read one project's expired claims, synchronously (it runs inside the child). Any failure is a
 * degraded result naming why; an unreadable target config is never replaced by a default lease.
 */
export function readProjectClaims({ project, root, now = Date.now(), budgetMs = CLAIM_READ_TIMEOUT_MS - 1_000 }) {
  try {
    if (!existsSync(root)) return degraded(project, root, 'root_missing');
    let route;
    try {
      route = resolveStoreRoute(root);
    } catch (e) {
      return degraded(project, root, `config_unreadable: ${e?.message ?? String(e)}`);
    }
    if (route === null) return degraded(project, root, 'not_initialized');
    if (route.storage !== 'sqlite') return degraded(project, root, `unsupported_storage: ${route.storage}`);
    if (!existsSync(route.projectDbPath)) return degraded(project, root, 'store_missing');
    const lease = route.config.board_claims.lease_minutes;
    const read = readForeignBoard(route.projectDbPath, { budgetMs });
    if (read.truncated) return degraded(project, root, `truncated: ${read.truncated}`);
    if (read.schemaVersion > SUPPORTED_SCHEMA_VERSION) return degraded(project, root, `unsupported_schema: v${read.schemaVersion}`);
    const claims = [];
    let unreadableClaims = 0;
    for (const item of read.items) {
      if (item.source !== 'user' || item.claim === undefined || item.claim === null) continue;
      const view = boardClaimView(item.claim, now, lease);
      if (view === undefined) continue;
      if (view.state === 'unreadable') {
        unreadableClaims += 1;
        continue;
      }
      if (view.state !== 'expired') continue;
      claims.push({
        project,
        id: item.id,
        id8: String(item.id).slice(0, 8),
        label: boardDisplayLabel(item.text, item.slug).split(/\r?\n/)[0].trim(),
        holder_session: view.holder_session,
        checkout: view.checkout,
        generation: view.generation,
        renewed_at: view.renewed_at,
        age_minutes: view.minutes_since_renewal,
        lease_minutes: lease,
      });
    }
    const gaps = [];
    if (read.unreadable.length) gaps.push(`${read.unreadable.length} board row(s) unreadable`);
    if (unreadableClaims) gaps.push(`${unreadableClaims} claim(s) unreadable`);
    if (gaps.length) return { project, root, degraded: true, reason: `partial: ${gaps.join(', ')}`, claims };
    return { project, root, claims };
  } catch (e) {
    return degraded(project, root, `read_failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Every registered project, each read in its own child process under ONE shared wall-clock
 * deadline. `projects` is [{project, root}]; a child that times out, dies or answers badly is
 * degraded. The caller never waits on a child past the deadline.
 */
// `entry` is the script the child re-runs with --claim-reader: the launched script itself (the shipped
// bin/ bundle or the scripts/ source), because import.meta.url names the scripts/ source even inside a bundle.
export function collectExpiredClaims({ projects, now = Date.now(), timeoutMs = CLAIM_READ_TIMEOUT_MS, start = fork, entry = resolve(process.argv[1]) }) {
  const deadline = performance.now() + timeoutMs;
  return Promise.all(
    projects.map(
      ({ project, root }) =>
        new Promise((resolve) => {
          let child;
          let settled = false;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child) child.kill('SIGKILL');
            resolve(result);
          };
          const timer = setTimeout(() => finish(degraded(project, root, 'timeout')), Math.max(0, deadline - performance.now()));
          try {
            child = start(entry, ['--claim-reader'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            child.once('error', () => finish(degraded(project, root, 'reader_failed')));
            child.once('exit', () => finish(degraded(project, root, 'reader_failed')));
            child.once('message', (result) => {
              if (performance.now() >= deadline) return finish(degraded(project, root, 'timeout'));
              finish(result?.project === project && (Array.isArray(result.claims) || result.degraded === true) ? result : degraded(project, root, 'reader_failed'));
            });
            child.send({ project, root, now, budgetMs: Math.max(0, deadline - performance.now() - 500) }, (error) => {
              if (error) finish(degraded(project, root, 'reader_failed'));
            });
          } catch {
            finish(degraded(project, root, 'reader_failed'));
          }
        })
    )
  );
}

/** The registered projects, from the registry file; refuses a missing registry rather than creating one. */
export function registeredProjects(regPath = registryPath()) {
  if (!existsSync(regPath)) throw new Error(`there is no project registry at ${regPath} (projects are registered by /sterling:init)`);
  // Read-only: a writable ProjectRegistry open would migrate the file and checkpoint its WAL (hazard 8616e72d).
  const { rows } = readRegistrySnapshotReadOnly(regPath, 1_000);
  return rows.map((r) => ({ project: r.name, root: r.repo_path }));
}

/** The whole report: expired claims across projects, and the projects that could not be read in full. */
export async function expiredClaimsReport({ regPath = registryPath(), now = Date.now(), timeoutMs = CLAIM_READ_TIMEOUT_MS, start } = {}) {
  const results = await collectExpiredClaims({ projects: registeredProjects(regPath), now, timeoutMs, ...(start ? { start } : {}) });
  return {
    expired: results.flatMap((r) => r.claims ?? []),
    degraded: results.filter((r) => r.degraded).map((r) => ({ project: r.project, root: r.root, reason: r.reason })),
    projects_read: results.length,
  };
}

// Private child entry point; never invoked merely by importing this module.
if (process.argv[2] === '--claim-reader' && typeof process.send === 'function') {
  process.once('message', (input) => {
    let result = readProjectClaims(input);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) result = degraded(input.project, input.root, 'result_too_large');
    process.send(result, () => process.disconnect());
  });
}
