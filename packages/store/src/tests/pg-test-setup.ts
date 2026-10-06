// Loaded with `node --import` by @sterling/store's test script. Without
// STERLING_TEST_PG=1 it does nothing. With it, every `new SterlingStore(path)`
// that passes no driver opens a PgDriver instead (setStoreDriverFactory), so
// the existing store tests run against Served unchanged.
//
// Per test process (node --test runs one per file): one bridge, one
// sterling_test_<random> prefix, its own <prefix>_meta, and one store schema
// <prefix>_<n> per distinct store path, created explicitly the first time the
// path is opened, the way a SQLite open creates a new file. Every schema under
// the prefix is dropped when the process exits, passing or failing. A process
// that is killed outright (SIGKILL) cannot clean up; the prefix names its run.

import { resolve } from 'node:path';
import { setStoreDriverFactory } from '../index.js';
import { PgDriver, createPgStore, ensurePgLayout } from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_TESTS_ENABLED, dropTestSchemas, newTestPrefix, openTestBridge } from './pg-test-support.js';

if (PG_TESTS_ENABLED) {
  const prefix = newTestPrefix();
  const meta = `${prefix}_meta`;
  const schemaByPath = new Map<string, string>();
  let bridge: PgBridge | undefined;

  const live = (): PgBridge => {
    if (bridge === undefined) {
      bridge = openTestBridge();
      ensurePgLayout(bridge, meta);
      // Synchronous on purpose: the bridge blocks, so the drop finishes inside
      // the exit handler. An uncaught failure still reaches 'exit'.
      process.on('exit', () => {
        if (!bridge || bridge.closed) return;
        try {
          dropTestSchemas(bridge, prefix);
        } finally {
          bridge.close();
        }
      });
    }
    return bridge;
  };

  setStoreDriverFactory((path) => {
    const b = live();
    const key = resolve(path);
    let schema = schemaByPath.get(key);
    if (schema === undefined) {
      schema = `${prefix}_${schemaByPath.size + 1}`;
      createPgStore(b, { kind: 'test', name: key, schema, metaSchema: meta });
      schemaByPath.set(key, schema);
    }
    return new PgDriver(b, { schema, metaSchema: meta });
  });
}
