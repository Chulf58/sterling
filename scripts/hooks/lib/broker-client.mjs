// The hook store broker, client side (decision
// hook-store-broker-whole-method-rpc-over-local-socket). A hook on a
// Postgres-storage project asks the session's MCP server for whole store
// operations over a local Unix socket instead of opening its own Postgres
// connection (a TLS login of about 750 ms per hook process).
//
// Hooks stay synchronous: a worker thread owns the socket and the main thread
// blocks in Atomics.wait for each reply, with a finite bound on every wait
// (BROKER_BOUNDS: connect, handshake, queue plus execute).
//
// Discovery and the handshake: the registry files published for this project
// (newest first) are read; each one's socket must be this user's 0600 socket
// in the validated runtime directory, and the server's own answer to the hello
// must match what this hook derives itself: the instance named in the registry
// file, the protocol, the project id, the canonical root and the storage
// identity (database label and schema names). A registration that fails any
// check is skipped, never removed. Pid is not checked.
//
// FALLBACK ONLY BEFORE DISPATCH. When no broker passes discovery and the
// handshake, the hook prints one DEGRADED line and opens its own connection
// through @sterling/store/routing. Once a call has been sent, a lost or late
// reply is BrokerOutcomeUnknownError: the operation may or may not have run,
// so it is never replayed, through another broker or a direct connection, and
// the client is closed for the rest of the process. A call the server refuses
// unexecuted (queue bound, unknown operation) throws its named error as well;
// the hook treats every broker error as a store failure.
//
// One exception to "only registered operations": withTransaction(fn) on the
// project store runs fn inside a transaction on a direct connection opened for
// it, with every store call fn makes routed to that connection, because a
// transaction must never wait on a hook's next frame. H10's article-demand
// recompute is the one caller.
import { realpathSync } from 'node:fs';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { BROKER_BOUNDS, BROKER_MAX_RESPONSE_BYTES, BROKER_PROTOCOL, brokerResultSchema, brokerWelcomeSchema, isBrokerOperation } from '@sterling/schemas';
import { assertPrivate, brokerDir, brokerSocketPath, brokerStorageIdentity, listBrokerRegistrations, openRoutedStores, resolveStoreRoute } from '@sterling/store/routing';

// The worker body: CommonJS, node builtins only, so it runs from a string in
// every bundle without a file beside it.
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const net = require('node:net');
const { port, signal, maxResponse } = workerData;
let sock = null;
let buf = Buffer.alloc(0);
let pending = null;
let dead = null;
const done = (msg) => { port.postMessage(msg); Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); };
const fail = (reason) => {
  if (dead === null) dead = reason;
  if (pending) { const p = pending; pending = null; done({ seq: p.seq, ok: false, failure: dead }); }
};
const onData = (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (len > maxResponse) { fail('a ' + len + '-byte response frame is over the ' + maxResponse + '-byte bound'); sock.destroy(); return; }
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    if (pending && pending.kind === 'send') { const p = pending; pending = null; done({ seq: p.seq, ok: true, body }); }
    else fail('an unexpected frame arrived with no call waiting');
  }
};
port.on('message', (m) => {
  if (m.kind === 'connect') {
    pending = { seq: m.seq, kind: 'connect' };
    sock = net.createConnection(m.path);
    sock.once('connect', () => { if (pending && pending.kind === 'connect') { const p = pending; pending = null; done({ seq: p.seq, ok: true }); } });
    sock.on('data', onData);
    sock.on('error', (e) => fail('socket error ' + (e.code || e.message)));
    sock.on('close', () => fail('the broker closed the connection'));
  } else if (m.kind === 'send') {
    if (dead !== null) { done({ seq: m.seq, ok: false, failure: dead }); return; }
    pending = { seq: m.seq, kind: 'send' };
    sock.write(Buffer.from(m.frame));
  } else if (m.kind === 'close') {
    if (sock) sock.destroy();
  }
});
`;

/** A call was sent and its reply was lost or late: it may or may not have run, and it is not replayed. */
export class BrokerOutcomeUnknownError extends Error {
  constructor(what, detail) {
    super(`hook store broker: the outcome of ${what} is unknown (${detail}). It may or may not have run; it was not replayed, and this hook makes no further broker calls.`);
    this.name = 'BrokerOutcomeUnknownError';
  }
}

/** A local refusal before anything was sent: the operation is not in the registry. */
export class BrokerOperationRefusedError extends Error {
  constructor(target, op) {
    super(`hook store broker: '${target}.${op}' is not in the operation registry (BROKER_OPERATIONS in @sterling/schemas); nothing was sent`);
    this.name = 'BrokerOperationRefusedError';
  }
}

/** The broker client was closed by an earlier outcome-unknown failure. */
export class BrokerClosedError extends Error {
  constructor(reason) {
    super(`hook store broker: this hook's broker connection is closed (${reason}); nothing was sent`);
    this.name = 'BrokerClosedError';
  }
}

// A blocking hook registers this so a broker or store failure ends the hook at
// the failure itself, whatever try/catch surrounds the call (H10's duty steps
// guard many store calls individually). Called with the error just before it
// is thrown; a handler that exits never returns.
let failureHandler = null;
/** Register `fn(error)` for broker failures and remote store-infrastructure failures in this process. */
export function onBrokerFailure(fn) {
  failureHandler = fn;
}
const INFRASTRUCTURE_ERROR = /^(Broker\w*Error|StoreUnreachableError|StoreSettingsError|DomainUnavailableError|PostgresStoreNotMovedError|PgStoreMissingError|Pg\w*Error)$/;
const failed = (e) => {
  if (failureHandler) failureHandler(e);
  return e;
};

/** Rebuild a remote error with its own name, so namedError and instance checks by name keep working. */
function remoteError(wire) {
  const name = /^[A-Za-z_$][\w$]*$/.test(wire.name) ? wire.name : 'Error';
  const Named = { [name]: class extends Error {} }[name];
  const e = new Named(wire.message);
  for (const [k, v] of Object.entries(wire.fields ?? {})) if (k !== 'message' && k !== 'stack') e[k] = v;
  e.name = name;
  return e;
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** One socket on one worker, driven synchronously. */
class SyncSocket {
  constructor() {
    this.signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.seq = 0;
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { port: port2, signal: this.signal, maxResponse: BROKER_MAX_RESPONSE_BYTES }, transferList: [port2] });
    this.worker.unref();
    this.port.unref();
    this.worker.on('error', () => {});
  }
  /** {ok:true, body?} or {ok:false, failure}; never throws. */
  request(msg, timeoutMs) {
    const seq = ++this.seq;
    this.port.postMessage({ ...msg, seq });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = Atomics.load(this.signal, 0);
      const got = receiveMessageOnPort(this.port);
      if (got) {
        if (got.message.seq === seq) return got.message;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, failure: `no reply within ${timeoutMs} ms`, timedOut: true };
      Atomics.wait(this.signal, 0, cur, left);
    }
  }
  close() {
    try {
      this.port.postMessage({ kind: 'close' });
    } catch {
      /* already gone */
    }
    this.worker.terminate();
  }
}

class BrokerClient {
  constructor(sock, identity, root) {
    this.sock = sock;
    this.identity = identity;
    this.root = root;
    this.nextId = 1;
    this.dead = null;
    this.txStore = null;
    this.direct = null;
    this.project = this.proxy('project', {
      close: () => {},
      withTransaction: (fn) => this.withTransaction(fn),
    });
    this.mounted = this.proxy('mounted', { project: this.project, close: () => {} });
  }

  proxy(target, extras) {
    return new Proxy(
      {},
      {
        get: (_, prop) => {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          if (Object.hasOwn(extras, prop)) return extras[prop];
          if (target === 'project' && this.txStore) {
            const v = this.txStore[prop];
            return typeof v === 'function' ? v.bind(this.txStore) : v;
          }
          return (...args) => this.call(target, prop, args);
        },
      }
    );
  }

  call(target, op, args) {
    if (!isBrokerOperation(target, op)) throw new BrokerOperationRefusedError(target, op);
    if (this.dead) throw failed(new BrokerClosedError(this.dead));
    const id = this.nextId++;
    const what = `'${target}.${op}' (call ${id} to instance ${this.identity.instance_id})`;
    const reply = this.sock.request({ kind: 'send', frame: frame({ type: 'call', id, target, op, args, sent_at: Date.now() }) }, BROKER_BOUNDS.queueMs + BROKER_BOUNDS.executeMs);
    if (!reply.ok) return this.lose(what, reply.failure);
    let res;
    try {
      res = brokerResultSchema.parse(JSON.parse(reply.body));
    } catch (e) {
      return this.lose(what, `the reply is not a result (${(e && e.message) || e})`);
    }
    if (res.id !== id) return this.lose(what, `the reply answers call ${res.id}`);
    if (res.ok) return res.result;
    const err = remoteError(res.error);
    throw INFRASTRUCTURE_ERROR.test(err.name) ? failed(err) : err;
  }

  lose(what, detail) {
    this.dead = `the outcome of ${what} is unknown`;
    this.sock.close();
    throw failed(new BrokerOutcomeUnknownError(what, detail));
  }

  withTransaction(fn) {
    if (!this.direct) this.direct = openRoutedStores(this.root).store;
    this.txStore = this.direct;
    try {
      return this.direct.withTransaction(fn);
    } finally {
      this.txStore = null;
    }
  }
}

/**
 * Find and greet a broker for `route` (a Postgres route). Returns
 * {client} or {client: null, reason}. Never throws: every failure here is
 * before dispatch, so the caller may fall back.
 */
export function connectBroker(route, { env = process.env } = {}) {
  let root;
  let storage;
  try {
    root = realpathSync(route.root);
    storage = brokerStorageIdentity(route);
  } catch (e) {
    return { client: null, reason: `this hook cannot derive its own identity (${(e && e.message) || e})` };
  }
  let dir;
  try {
    dir = brokerDir({ create: false, env });
  } catch (e) {
    return { client: null, reason: (e && e.message) || String(e) };
  }
  if (dir === undefined) return { client: null, reason: 'no broker runtime directory exists, so no MCP server has published a broker' };
  let listed;
  try {
    listed = listBrokerRegistrations(dir, root);
  } catch (e) {
    return { client: null, reason: `the broker registry cannot be read (${(e && e.message) || e})` };
  }
  const reasons = listed.refused.map((r) => `${r.file}: ${r.reason}`);
  // Instances that accepted the connection but sent no welcome in time: the
  // server's event loop is busy (the broker shares it with the tool calls),
  // not absent.
  let silent = 0;
  for (const reg of listed.registrations) {
    const tag = `instance ${reg.instance_id}`;
    const mismatch =
      reg.protocol !== BROKER_PROTOCOL ? `protocol ${reg.protocol}, not ${BROKER_PROTOCOL}` :
      reg.project_id !== route.projectId ? `project ${reg.project_id}, not ${route.projectId}` :
      reg.root !== root ? `root ${reg.root}, not ${root}` :
      JSON.stringify(reg.storage) !== JSON.stringify(storage) ? `storage ${JSON.stringify(reg.storage)}, not ${JSON.stringify(storage)}` :
      reg.socket !== brokerSocketPath(dir, reg.instance_id) ? `socket ${reg.socket} is not this instance's path in ${dir}` : null;
    if (mismatch) {
      reasons.push(`${tag}: registered ${mismatch}`);
      continue;
    }
    try {
      assertPrivate(reg.socket, 'socket');
    } catch (e) {
      reasons.push(`${tag}: ${e.message}`);
      continue;
    }
    const sock = new SyncSocket();
    const connected = sock.request({ kind: 'connect', path: reg.socket }, BROKER_BOUNDS.connectMs);
    if (!connected.ok) {
      sock.close();
      reasons.push(`${tag}: connect failed (${connected.failure})`);
      continue;
    }
    const hello = sock.request({ kind: 'send', frame: frame({ type: 'hello', protocol: BROKER_PROTOCOL, instance_id: reg.instance_id, project_id: route.projectId, root }) }, BROKER_BOUNDS.handshakeMs);
    let welcome;
    try {
      if (!hello.ok) throw new Error(hello.failure);
      welcome = brokerWelcomeSchema.parse(JSON.parse(hello.body));
    } catch (e) {
      sock.close();
      if (hello.timedOut) {
        silent++;
        reasons.push(`${tag}: connected, no handshake reply within ${BROKER_BOUNDS.handshakeMs} ms`);
      } else {
        reasons.push(`${tag}: handshake failed (${(e && e.message) || e})`);
      }
      continue;
    }
    if (welcome.type === 'refused') {
      sock.close();
      reasons.push(`${tag}: refused the hello (${welcome.error.name}: ${welcome.error.message})`);
      continue;
    }
    const id = welcome.identity;
    const wrong =
      id.instance_id !== reg.instance_id ? `answered as instance ${id.instance_id}` :
      id.protocol !== BROKER_PROTOCOL ? `answered with protocol ${id.protocol}` :
      id.project_id !== route.projectId ? `answered for project ${id.project_id}` :
      id.root !== root ? `answered for root ${id.root}` :
      JSON.stringify(id.storage) !== JSON.stringify(storage) ? `answered with storage ${JSON.stringify(id.storage)}` : null;
    if (wrong) {
      sock.close();
      reasons.push(`${tag}: refused, the server ${wrong}`);
      continue;
    }
    return { client: new BrokerClient(sock, id, route.root) };
  }
  if (!listed.registrations.length && !reasons.length) reasons.push('no MCP server has published a broker for this project');
  // busy: every reason is a silent instance, so a server is up and only late.
  return { client: null, reason: reasons.join('; '), busy: silent > 0 && silent === reasons.length };
}

const clients = new Map();
let degradedSaid = false;

/**
 * The DEGRADED line a hook prints when it falls back to its own connection.
 * `busy` is connectBroker's verdict that every candidate connected and then
 * stayed silent: the headline then says the server is busy, not absent.
 */
export function brokerFallbackLine(reason, busy = false) {
  const headline = busy
    ? `the hook store broker for this project is busy (${reason}; the MCP server is likely running a long tool call)`
    : `no hook store broker answered for this project (${reason})`;
  return `Sterling hook: DEGRADED — ${headline}; this hook opens its own Postgres connection, which costs a login per hook.\n`;
}

/**
 * The routed stores for a hook in a Postgres-storage project at `root`:
 * through a broker when one passes discovery and the handshake, otherwise
 * through a direct connection after one DEGRADED stderr line. `mount` asks for
 * the mounted set ({stores}) instead of the project store ({store}). Route and
 * open errors on the direct path throw by name, as openRoutedStores does.
 */
export function openRoutedForHook(root, { mount = false } = {}) {
  const route = resolveStoreRoute(root);
  if (route?.storage !== 'postgres') return mount ? { stores: openRoutedStores(root, { mount: true }).stores } : { store: openRoutedStores(root).store };
  // One discovery per process. A client closed by an outcome-unknown failure is
  // kept, so every later call throws BrokerClosedError instead of reconnecting.
  let got = clients.get(route.root);
  if (got === undefined) {
    got = connectBroker(route);
    clients.set(route.root, got);
  }
  if (got.client) return mount ? { stores: got.client.mounted } : { store: got.client.project };
  if (!degradedSaid) {
    degradedSaid = true;
    try {
      process.stderr.write(brokerFallbackLine(got.reason, got.busy));
    } catch {
      /* stderr is gone; the direct open below still names its own failures */
    }
  }
  return mount ? { stores: openRoutedStores(root, { mount: true }).stores } : { store: openRoutedStores(root).store };
}
