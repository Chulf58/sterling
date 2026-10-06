// The Postgres worker: one node-postgres client on its own thread, driven by
// PgBridge (pg-bridge.ts) through a SharedArrayBuffer and a MessagePort
// (decision postgres-store-backend-design-sync-bridge-schema-per-store, point 1).
//
// Self-contained on purpose: its only imports are pg and node builtins, so a
// build can bundle it alone and place it beside every hook as pg-worker.js.
// The protocol constants below are therefore repeated in pg-bridge.ts; the two
// copies must stay equal.
//
// Protocol. The bridge spawns this file, then posts one init message on
// parentPort: { control: SharedArrayBuffer, port: MessagePort, config }. Every
// reply goes out on `port`, after which control[0] is set to REPLY and
// notified. A death (uncaught error, process.exit, a client error) sets DEAD
// instead, so a bridge blocked in Atomics.wait learns of it without waiting out
// its timeout. The main thread's event loop is frozen while it waits, so the
// Worker 'error' and 'exit' events cannot tell it; this buffer is the only
// channel that works.

import { parentPort, type MessagePort } from 'node:worker_threads';
import pg from 'pg';

const STATE_REPLY = 1;
const STATE_DEAD = 2;

interface WorkerError {
  name: string;
  message: string;
  code?: string;
}

interface Request {
  seq: number;
  op: 'query' | 'close';
  text?: string;
  values?: unknown[];
}

// int8 (count(*), bigint columns): a number when it is a safe integer, as
// node:sqlite returns it; a bigint otherwise, never a silently rounded number.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : BigInt(v);
});

function toWorkerError(e: unknown): WorkerError {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { name: e.name, message: e.message, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { name: 'Error', message: String(e) };
}

if (!parentPort) throw new Error('pg-worker: must run as a worker thread');

parentPort.once('message', (init: { control: SharedArrayBuffer; port: MessagePort; config: Record<string, unknown> }) => {
  const control = new Int32Array(init.control);
  const port = init.port;
  let currentSeq = 0;
  let finished = false;

  const signal = (state: number) => {
    Atomics.store(control, 0, state);
    Atomics.notify(control, 0);
  };
  const reply = (msg: Record<string, unknown>) => {
    port.postMessage({ seq: currentSeq, ...msg });
    signal(STATE_REPLY);
  };
  const die = (e: unknown) => {
    if (finished) return;
    finished = true;
    port.postMessage({ seq: currentSeq, ok: false, dead: true, error: toWorkerError(e) });
    signal(STATE_DEAD);
  };

  process.on('uncaughtException', (e) => {
    die(e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    die(e);
    process.exit(1);
  });
  process.on('exit', (code) => die(new Error(`pg-worker exited with code ${code}`)));

  const client = new pg.Client(init.config);
  // A connection lost between statements: the client is unusable from here on.
  client.on('error', (e) => {
    die(e ?? new Error('pg-worker: client error'));
    process.exit(1);
  });

  client.connect().then(
    () => {
      reply({ ok: true, ready: true });
      port.on('message', (req: Request) => {
        currentSeq = req.seq;
        if (req.op === 'close') {
          client.end().then(
            () => {
              reply({ ok: true, closed: true });
              finished = true;
              port.close();
            },
            (e: unknown) => {
              reply({ ok: false, error: toWorkerError(e) });
              finished = true;
              port.close();
            },
          );
          return;
        }
        client.query(req.text ?? '', req.values).then(
          (res) => {
            // A multi-statement simple query (exec) returns one result per statement.
            const last = Array.isArray(res) ? res[res.length - 1] : res;
            reply({ ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 });
          },
          (e: unknown) => reply({ ok: false, error: toWorkerError(e) }),
        );
      });
    },
    (e: unknown) => {
      reply({ ok: false, error: toWorkerError(e) });
      finished = true;
      port.close();
    },
  );
});
