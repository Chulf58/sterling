// A fault-injecting stand-in for pg-worker.js, loaded only by pg-bridge.test.ts
// through PgBridgeOptions.workerUrl. The mode comes from the environment the
// worker inherits:
//   load-throw  the module throws before it can read its init message
//   crash       the real worker runs, then an uncaught throw lands 4 s after load
//   exit        the real worker runs, then process.exit(9) lands 4 s after load
// 'crash' and 'exit' import the real worker so its own death handlers are the
// ones under test.

const mode = process.env.STERLING_PG_FIXTURE_MODE;

if (mode === 'load-throw') {
  throw new Error('pg fixture worker: died at load');
}

await import('../pg-worker.js');

if (mode === 'crash') {
  setTimeout(() => {
    throw new Error('pg fixture worker: crashed after the handshake');
  }, 4000);
} else if (mode === 'exit') {
  setTimeout(() => process.exit(9), 4000);
} else {
  throw new Error(`pg fixture worker: unknown STERLING_PG_FIXTURE_MODE '${String(mode)}'`);
}
