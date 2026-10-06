// Shared support for the store tests that run against Postgres (Served).
//
// STERLING_TEST_PG=1 is the one switch: with it, pg-*.test.ts talk to the
// database named in ~/.sterling/credentials/served.json and the other store
// tests open their stores through PgDriver (pg-test-setup.ts). Without it the
// pg-*.test.ts tests skip and every other test runs on SQLite as before.
//
// Isolation: every test process works under its own sterling_test_<random>
// prefix (decision postgres-schema-names-sterling-p-uuid-sterling-d-domain):
// the meta schema is <prefix>_meta and the stores are <prefix>_<n>. Nothing
// here touches a schema outside that prefix.

import { randomBytes } from 'node:crypto';
import { PgBridge, readPgCredentials, type PgBridgeOptions } from '../pg-bridge.js';

export const PG_TESTS_ENABLED = process.env.STERLING_TEST_PG === '1';

/** The skip reason node:test prints when STERLING_TEST_PG is not set. */
export const PG_SKIP = PG_TESTS_ENABLED ? false : 'set STERLING_TEST_PG=1 to run against Served';

export function newTestPrefix(): string {
  return `sterling_test_${randomBytes(6).toString('hex')}`;
}

export function openTestBridge(options: PgBridgeOptions = {}): PgBridge {
  return new PgBridge(readPgCredentials(), options);
}

/** Every schema whose name starts with `prefix` (a sterling_test_ prefix only). */
export function schemasWithPrefix(bridge: PgBridge, prefix: string): string[] {
  if (!/^sterling_test_[a-z0-9]+$/.test(prefix)) throw new Error(`refusing a test prefix outside sterling_test_: '${prefix}'`);
  const rows = bridge.query("SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1) ORDER BY nspname", [`${prefix}_`]).rows;
  return rows.map((r) => String(r.nspname));
}

/** Drop every schema under `prefix`. Returns the names dropped. */
export function dropTestSchemas(bridge: PgBridge, prefix: string): string[] {
  const names = schemasWithPrefix(bridge, prefix);
  for (const name of names) bridge.query(`DROP SCHEMA "${name}" CASCADE`);
  return names;
}

/** A blocking sleep for tests that poll the server from a synchronous bridge. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The one marker for a test that asserts SQLite file, journal or user_version
 * mechanics, or that waits on item 5 routing: `test(name, { skip: sqliteOnly(reason) }, fn)`.
 * On SQLite it is false and the test runs unchanged; under STERLING_TEST_PG=1
 * the test is skipped and node:test prints the reason.
 */
export function sqliteOnly(reason: string): string | false {
  return PG_TESTS_ENABLED ? `SQLite-only under STERLING_TEST_PG=1: ${reason}` : false;
}
