// The hook store broker, server side (decision
// hook-store-broker-whole-method-rpc-over-local-socket). On Postgres storage
// this MCP server already holds one connection and the routed stores; hooks
// connect to it over a local Unix socket and ask for whole operations from a
// fixed registry (BROKER_OPERATIONS in @sterling/schemas), instead of each
// hook process paying its own TLS login.
//
// What it guarantees:
// - Only registered operations run, each to completion inside one synchronous
//   call on this process's stores. No transaction is ever open between frames:
//   a store method that uses one opens and closes it within the call. Tool
//   calls and broker calls share the one event loop, so they never interleave
//   inside an operation.
// - The handshake answers with this server's own identity (a random instance
//   id, the protocol, build, project id, canonical root and storage identity)
//   and refuses a hello that names another instance, project, root or protocol.
// - Request frames above BROKER_MAX_REQUEST_BYTES close the connection. A call
//   that waited longer than BROKER_BOUNDS.queueMs before it could start is
//   refused unexecuted (executed: false), so the hook may fall back.
// - Errors cross the socket with their name, message and plain fields.
// - The socket is 0600 in a validated 0700 directory; the registry file is
//   published only after the socket listens, and this server removes its own
//   files when it closes. It never removes another server's files.
// What it does not do: authenticate beyond file ownership (the socket is
// reachable only by this user), or serve SQLite storage (hooks open SQLite
// files directly, as before).
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync } from 'node:fs';
import {
  BROKER_BOUNDS,
  BROKER_MAX_REQUEST_BYTES,
  BROKER_MAX_RESPONSE_BYTES,
  BROKER_PROTOCOL,
  brokerCallSchema,
  brokerHelloSchema,
  buildIdPath,
  isBrokerOperation,
  type BrokerError,
  type BrokerIdentity,
} from '@sterling/schemas';
import { assertPrivate, brokerDir, brokerSocketPath, brokerStorageIdentity, publishBrokerRegistration, removeOwnBrokerFiles, type PostgresStoreRoute } from '@sterling/store/routing';
import type { MountedStores } from '@sterling/store';

export interface HookBroker {
  readonly identity: BrokerIdentity;
  readonly socketPath: string;
  readonly registrationPath: string;
  /** Stop listening and remove this server's own socket and registry file. Synchronous file removal, safe in an exit handler. */
  close(): void;
}

export interface StartHookBrokerOptions {
  stores: MountedStores;
  route: PostgresStoreRoute;
  /** The directory holding the server's .build-id. */
  serverDir: string;
  env?: NodeJS.ProcessEnv;
}

function buildIdOf(serverDir: string): string {
  try {
    return readFileSync(buildIdPath(serverDir), 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** An error as it crosses the socket: name, message and its plain string or number fields. */
export function wireError(e: unknown): BrokerError {
  const err = e as Error & Record<string, unknown>;
  const name = err?.constructor?.name && err.constructor.name !== 'Object' && err.constructor.name !== 'Error' ? err.constructor.name : (err?.name ?? 'Error');
  const fields: Record<string, string | number> = {};
  if (err && typeof err === 'object') {
    for (const [k, v] of Object.entries(err)) if (typeof v === 'string' || typeof v === 'number') fields[k] = v;
  }
  return { name, message: String(err?.message ?? e), fields };
}

const named = (name: string, message: string): BrokerError => ({ name, message, fields: {} });

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** A synchronous pause, used only by the test hold below. */
function holdMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start the broker for a Postgres-storage project and resolve once its
 * registry file is published. Resolves null where Unix sockets and uids do not
 * exist (native Windows). Rejects, naming the reason, when the runtime
 * directory is unsafe.
 */
export async function startHookBroker({ stores, route, serverDir, env = process.env }: StartHookBrokerOptions): Promise<HookBroker | null> {
  const dir = brokerDir({ create: true, env });
  if (dir === undefined) return null;
  const instanceId = randomBytes(16).toString('hex');
  const root = realpathSync(route.root);
  const identity: BrokerIdentity = {
    instance_id: instanceId,
    protocol: BROKER_PROTOCOL,
    build_id: buildIdOf(serverDir),
    project_id: route.projectId,
    root,
    storage: brokerStorageIdentity(route),
    pid: process.pid,
  };
  const socketPath = brokerSocketPath(dir, instanceId);
  // Test seam: hold every call this long before it runs, so a test can kill the
  // server while an operation is in flight. Unset in production.
  const testHold = Number(env.STERLING_BROKER_TEST_HOLD_MS ?? 0);

  const execute = (target: 'project' | 'mounted', op: string, args: unknown[]): unknown => {
    const obj = (target === 'project' ? stores.project : stores) as unknown as Record<string, (...a: unknown[]) => unknown>;
    return obj[op].apply(obj, args);
  };

  const serve = (conn: Socket): void => {
    conn.unref();
    let buf = Buffer.alloc(0);
    let greeted = false;
    const send = (value: unknown): void => {
      conn.write(frame(value));
    };
    const handle = (msg: unknown): void => {
      if (!greeted) {
        const hello = brokerHelloSchema.safeParse(msg);
        let refusal: BrokerError | undefined;
        if (!hello.success) refusal = named('BrokerHandshakeError', `the first frame is not a hello: ${hello.error.message}`);
        else if (hello.data.protocol !== BROKER_PROTOCOL) refusal = named('BrokerProtocolMismatchError', `protocol ${hello.data.protocol} asked, this server speaks ${BROKER_PROTOCOL}`);
        else if (hello.data.instance_id !== instanceId) refusal = named('BrokerIdentityMismatchError', `the hello names instance ${hello.data.instance_id}; this server is ${instanceId}`);
        else if (hello.data.project_id !== identity.project_id || hello.data.root !== identity.root)
          refusal = named('BrokerIdentityMismatchError', `the hello names project ${hello.data.project_id} at ${hello.data.root}; this server serves ${identity.project_id} at ${identity.root}`);
        if (refusal) {
          send({ type: 'refused', error: refusal });
          conn.end();
          return;
        }
        greeted = true;
        send({ type: 'welcome', identity });
        return;
      }
      const call = brokerCallSchema.safeParse(msg);
      if (!call.success) {
        const id = typeof (msg as { id?: unknown })?.id === 'number' ? (msg as { id: number }).id : 0;
        send({ type: 'result', id, ok: false, executed: false, error: named('BrokerRequestInvalidError', call.error.message) });
        return;
      }
      const { id, target, op, args, sent_at } = call.data;
      if (!isBrokerOperation(target, op)) {
        send({ type: 'result', id, ok: false, executed: false, error: named('BrokerOperationRefusedError', `'${target}.${op}' is not in the broker's operation registry; nothing ran`) });
        return;
      }
      if (Date.now() - sent_at > BROKER_BOUNDS.queueMs) {
        send({ type: 'result', id, ok: false, executed: false, error: named('BrokerQueueTimeoutError', `the call waited ${Date.now() - sent_at} ms before it could start (bound ${BROKER_BOUNDS.queueMs} ms); nothing ran`) });
        return;
      }
      if (testHold > 0) holdMs(testHold);
      let response: unknown;
      try {
        response = { type: 'result', id, ok: true, result: execute(target, op, args) };
      } catch (e) {
        response = { type: 'result', id, ok: false, executed: true, error: wireError(e) };
      }
      let out = frame(response);
      if (out.length - 4 > BROKER_MAX_RESPONSE_BYTES) {
        out = frame({ type: 'result', id, ok: false, executed: true, error: named('BrokerResponseTooLargeError', `the result of '${target}.${op}' is ${out.length - 4} bytes, over the ${BROKER_MAX_RESPONSE_BYTES}-byte bound; the operation ran`) });
      }
      conn.write(out);
    };
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > BROKER_MAX_REQUEST_BYTES) {
          send({ type: 'result', id: 0, ok: false, executed: false, error: named('BrokerFrameTooLargeError', `a ${len}-byte request frame is over the ${BROKER_MAX_REQUEST_BYTES}-byte bound; the connection is closed and nothing ran`) });
          conn.end();
          buf = Buffer.alloc(0);
          return;
        }
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        let msg: unknown;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          send({ type: 'result', id: 0, ok: false, executed: false, error: named('BrokerRequestInvalidError', `a frame is not JSON (${(e as Error).message})`) });
          continue;
        }
        handle(msg);
      }
    });
    conn.on('error', () => {
      /* a hook that went away mid-reply; its own side reports the loss */
    });
  };

  const server: Server = createServer(serve);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  chmodSync(socketPath, 0o600);
  assertPrivate(socketPath, 'socket');
  const registrationPath = publishBrokerRegistration(dir, root, { ...identity, socket: socketPath });
  // The stdio transport keeps the process alive; the broker never does.
  server.unref();

  let closed = false;
  return {
    identity,
    socketPath,
    registrationPath,
    close() {
      if (closed) return;
      closed = true;
      removeOwnBrokerFiles(dir, root, instanceId);
      server.close();
    },
  };
}
