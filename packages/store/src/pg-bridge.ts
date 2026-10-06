// The synchronous bridge to Postgres (decision
// postgres-store-backend-design-sync-bridge-schema-per-store, point 1).
// SterlingStore and its callers are synchronous; node-postgres is not. The
// bridge runs one pg client on a worker thread (pg-worker.ts) and blocks the
// calling thread in Atomics.wait until the worker replies.
//
// Rules, from the measurements on issue 26 (2026-10-06):
// - Every wait is finite. A timeout terminates the worker, which closes its
//   socket, and the bridge refuses every later call.
// - While Atomics.wait blocks, the Worker 'error' and 'exit' events cannot
//   fire, so the worker reports its own failures through the shared buffer.
//   A worker that dies before it reads its init message (a load failure)
//   cannot do that; the startup handshake's finite wait reports it.
// - The worker is unref'd, so a bridge that is never closed does not keep its
//   process alive, and close() terminates it.
//
// pg itself is imported only by the worker, so a process that never builds a
// PgBridge never loads it.
//
// Lifted from OpenSterling (packages/knowledge-postgres at 0e140e1, finding
// opensterling-reuse-map-for-postgres-backend-items-3-7): redactSecrets from
// sanitize.mjs, and the explicit-config rules of buildPoolConfig and
// tls-url.mjs (no ambient PG* fallback, an allowlist of keys, only the
// require and verify-full TLS modes, direct negotiation only with TLS),
// adapted to the credentials file's shape.

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Repeated in pg-worker.ts, which imports nothing of ours.
const STATE_WAITING = 0;
const STATE_REPLY = 1;
const STATE_DEAD = 2;

export const DEFAULT_PG_CREDENTIALS_PATH = join(homedir(), '.sterling', 'credentials', 'served.json');
/** How long a query waits for its reply when the opener sets nothing. */
export const DEFAULT_PG_WAIT_TIMEOUT_MS = 10_000;
/** Added to the connect timeout for the handshake: worker start-up plus loading pg, which took over 1.5 s with a dozen test processes starting at once from /mnt/c (measured 2026-10-06). */
const HANDSHAKE_MARGIN_MS = 5000;

export class PgConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgConfigError';
  }
}

/** A finite wait ran out. The worker was terminated and the bridge is closed. */
export class PgBridgeTimeoutError extends Error {
  constructor(
    readonly phase: 'handshake' | 'query' | 'close',
    readonly timeoutMs: number,
    detail: string,
  ) {
    super(`Postgres bridge: no reply within ${timeoutMs} ms during the ${phase} (${detail}); the worker was terminated and its connection closed.`);
    this.name = 'PgBridgeTimeoutError';
  }
}

/** The worker reported its own death: an uncaught error, an exit, or a lost connection. The bridge is closed. */
export class PgWorkerDiedError extends Error {
  constructor(
    readonly reason: string,
    readonly code?: string,
  ) {
    super(`Postgres bridge: the worker died (${reason}); the bridge is closed.`);
    this.name = 'PgWorkerDiedError';
  }
}

export class PgBridgeClosedError extends Error {
  constructor(why: string) {
    super(`Postgres bridge is closed (${why}); open a new one.`);
    this.name = 'PgBridgeClosedError';
  }
}

/**
 * One connection holds one transaction (decision
 * postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
 * point 6): a second store handle on the same bridge may not BEGIN while
 * another holds a transaction open, because its statements would silently run
 * inside that other transaction.
 */
export class PgTransactionOpenError extends Error {
  constructor(wanted: string, holder: string) {
    super(`Postgres bridge: ${wanted} cannot begin a transaction: this connection already has one open for ${holder}. One connection holds one transaction; nothing was sent.`);
    this.name = 'PgTransactionOpenError';
  }
}

/** The server refused a statement. `code` is the SQLSTATE when Postgres gave one. */
export class PgQueryError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    /** True when the failure was in the query's prefix (PgBridge.query's `prefix`), not the statement. */
    readonly inPrefix = false,
  ) {
    super(message);
    this.name = 'PgQueryError';
  }
}

// ---------------------------------------------------------------------------
// Credentials and client config
// ---------------------------------------------------------------------------

/** The client config the worker hands to `new pg.Client()`. Plain data: it crosses to the worker by postMessage. */
export interface PgConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { rejectUnauthorized: boolean; servername?: string };
  sslnegotiation: 'postgres' | 'direct';
  connectionTimeoutMillis: number;
}

const CREDENTIAL_KEYS = ['host', 'port', 'database', 'user', 'password', 'ssl', 'gssencmode', 'connect_timeout_ms'];
const SSL_KEYS = ['mode', 'negotiation', 'servername', 'rejectUnauthorized'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validates the credentials file's object and maps it to a client config.
 * Every field is explicit: nothing falls back to PG* environment variables or
 * ~/.pgpass. Messages name the field, never its value, so a refusal cannot leak
 * the password.
 */
export function buildPgConnectionConfig(creds: unknown): PgConnectionConfig {
  if (!isPlainObject(creds)) throw new PgConfigError('credentials must be a JSON object');
  for (const key of Object.keys(creds)) {
    if (!CREDENTIAL_KEYS.includes(key)) throw new PgConfigError(`credentials key '${key}' is not recognised; allowed: ${CREDENTIAL_KEYS.join(', ')}`);
  }
  for (const field of ['host', 'database', 'user'] as const) {
    if (typeof creds[field] !== 'string' || (creds[field] as string).length === 0) throw new PgConfigError(`credentials.${field} must be a non-empty string`);
  }
  if (!Number.isInteger(creds.port) || (creds.port as number) < 1 || (creds.port as number) > 65535) {
    throw new PgConfigError('credentials.port must be an integer between 1 and 65535');
  }
  if (typeof creds.password !== 'string') throw new PgConfigError('credentials.password must be a string');
  // node-postgres cannot do GSS encryption, so 'disable' is the only truthful value.
  if (creds.gssencmode !== undefined && creds.gssencmode !== 'disable') {
    throw new PgConfigError("credentials.gssencmode must be 'disable' (node-postgres has no GSS encryption)");
  }
  const timeout = creds.connect_timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) <= 0) throw new PgConfigError('credentials.connect_timeout_ms must be a positive integer');

  let ssl: PgConnectionConfig['ssl'] = false;
  let sslnegotiation: PgConnectionConfig['sslnegotiation'] = 'postgres';
  if (creds.ssl !== undefined) {
    const s = creds.ssl;
    if (!isPlainObject(s)) throw new PgConfigError('credentials.ssl must be an object');
    for (const key of Object.keys(s)) {
      if (!SSL_KEYS.includes(key)) throw new PgConfigError(`credentials.ssl key '${key}' is not recognised; allowed: ${SSL_KEYS.join(', ')}`);
    }
    if (s.mode !== 'require' && s.mode !== 'verify-full') throw new PgConfigError("credentials.ssl.mode must be 'require' or 'verify-full'");
    if (typeof s.rejectUnauthorized !== 'boolean') throw new PgConfigError('credentials.ssl.rejectUnauthorized must be a boolean');
    // require = encrypted, certificate not verified; verify-full = verified. The flag must say the same thing as the mode.
    if (s.rejectUnauthorized !== (s.mode === 'verify-full')) {
      throw new PgConfigError(`credentials.ssl.rejectUnauthorized must be ${s.mode === 'verify-full'} for mode '${s.mode}' (verify-full verifies the certificate, require does not)`);
    }
    if (s.servername !== undefined && (typeof s.servername !== 'string' || s.servername.length === 0)) {
      throw new PgConfigError('credentials.ssl.servername must be a non-empty string when given');
    }
    if (s.negotiation !== undefined && s.negotiation !== 'postgres' && s.negotiation !== 'direct') {
      throw new PgConfigError("credentials.ssl.negotiation must be 'postgres' or 'direct'");
    }
    ssl = { rejectUnauthorized: s.rejectUnauthorized, ...(s.servername !== undefined ? { servername: s.servername as string } : {}) };
    sslnegotiation = (s.negotiation as PgConnectionConfig['sslnegotiation'] | undefined) ?? 'postgres';
  }
  return {
    host: creds.host as string,
    port: creds.port as number,
    database: creds.database as string,
    user: creds.user as string,
    password: creds.password,
    ssl,
    sslnegotiation,
    connectionTimeoutMillis: timeout as number,
  };
}

/** Reads the credentials file explicitly (design point 10). It must exist and be readable by its owner only. */
export function readPgCredentials(path: string = DEFAULT_PG_CREDENTIALS_PATH): PgConnectionConfig {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (e) {
    throw new PgConfigError(`Postgres credentials file '${path}' cannot be read: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new PgConfigError(`Postgres credentials file '${path}' is readable by group or other (mode ${(mode & 0o777).toString(8)}); set it to mode 600`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PgConfigError(`Postgres credentials file '${path}' is not valid JSON: ${(e as Error).message}`);
  }
  return buildPgConnectionConfig(parsed);
}

/** Lifted from OpenSterling sanitize.mjs: removes each secret, raw and URI-encoded, from `text`. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join('[redacted]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export interface PgBridgeOptions {
  /** How long one statement waits for its reply. Default 10 000 ms. */
  waitTimeoutMs?: number;
  /** How long the start-up handshake (worker load, TLS, authentication) waits. Default: the connect timeout plus 5 s. */
  handshakeTimeoutMs?: number;
  /** Tests only: a stand-in worker module. Production always loads ./pg-worker.js. */
  workerUrl?: URL;
}

export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface Reply {
  seq: number;
  ok: boolean;
  dead?: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  prefixFailed?: boolean;
  error?: { name: string; message: string; code?: string };
}

export class PgBridge {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly control: Int32Array;
  private readonly secrets: string[];
  private seq = 0;
  private closedReason: string | undefined;
  private txOwner: object | undefined;
  private txOwnerLabel = '';
  /** How long one statement waits for its reply. Server-side timeouts must be shorter, so the named server error arrives first. */
  readonly waitTimeoutMs: number;

  constructor(config: PgConnectionConfig, options: PgBridgeOptions = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_PG_WAIT_TIMEOUT_MS;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? config.connectionTimeoutMillis + HANDSHAKE_MARGIN_MS;
    for (const [name, v] of [['waitTimeoutMs', this.waitTimeoutMs], ['handshakeTimeoutMs', handshakeTimeoutMs]] as const) {
      if (!Number.isInteger(v) || v <= 0) throw new PgConfigError(`PgBridge: ${name} must be a positive integer`);
    }
    this.secrets = [config.password];
    this.control = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.port.unref();
    this.worker =
      options.workerUrl === undefined
        ? new Worker(new URL('./pg-worker.js', import.meta.url))
        : new Worker(options.workerUrl);
    this.worker.unref();
    // The worker reports its own failures through the shared buffer. This
    // listener only keeps a worker error from becoming an uncaught exception in
    // this process once its event loop runs again; the failure itself has
    // already been thrown to the caller by then.
    this.worker.on('error', () => {});
    Atomics.store(this.control, 0, STATE_WAITING);
    this.worker.postMessage({ control: this.control.buffer, port: port2, config }, [port2]);
    this.await(0, 'handshake', handshakeTimeoutMs, 'the worker did not report ready; it may have died at load, or the server did not answer');
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** The handle whose transaction is open on this connection, if any. */
  get transactionOwner(): object | undefined {
    return this.txOwner;
  }

  /** Records that `owner` opens a transaction. Refuses when any handle, `owner` included, already holds one. */
  claimTransaction(owner: object, label: string): void {
    if (this.txOwner !== undefined) throw new PgTransactionOpenError(label, this.txOwnerLabel);
    this.txOwner = owner;
    this.txOwnerLabel = label;
  }

  /** Records that `owner`'s transaction ended. A no-op for any other handle. */
  releaseTransaction(owner: object): void {
    if (this.txOwner === owner) {
      this.txOwner = undefined;
      this.txOwnerLabel = '';
    }
  }

  /**
   * Runs one statement. With `values` it is a parameterised query ($1, $2, ...); without, a simple query that may hold several statements.
   * `prefix`, a simple query, goes out in the same round trip ahead of the statement; when it fails the call throws a PgQueryError with
   * `inPrefix` set and the statement's result is discarded (the statement may still have run, so the caller passes only a read).
   */
  query(text: string, values?: unknown[], prefix?: string): PgQueryResult {
    const reply = this.send({ op: 'query', text, values, ...(prefix !== undefined ? { prefix } : {}) }, 'query', this.waitTimeoutMs);
    return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? 0 };
  }

  /** Ends the connection and stops the worker. Idempotent. */
  close(): void {
    if (this.closed) return;
    try {
      this.send({ op: 'close' }, 'close', this.waitTimeoutMs);
    } finally {
      this.shutDown('close() was called');
    }
  }

  private send(req: { op: 'query' | 'close'; text?: string; values?: unknown[]; prefix?: string }, phase: 'query' | 'close', timeoutMs: number): Reply {
    if (this.closedReason !== undefined) throw new PgBridgeClosedError(this.closedReason);
    // The worker may have died between calls (a connection lost while idle):
    // its death message is already queued and the state already says DEAD.
    const queued = receiveMessageOnPort(this.port)?.message as Reply | undefined;
    const previous = Atomics.compareExchange(this.control, 0, STATE_REPLY, STATE_WAITING);
    if (queued?.dead || previous === STATE_DEAD) {
      const reason = queued?.error ? this.redact(queued.error.message) : 'it stopped between calls';
      this.shutDown(`the worker died: ${reason}`);
      throw new PgWorkerDiedError(reason, queued?.error?.code);
    }
    const seq = ++this.seq;
    this.port.postMessage({ seq, ...req });
    return this.await(seq, phase, timeoutMs, phase === 'query' ? 'the statement did not finish' : 'the connection did not end');
  }

  private await(seq: number, phase: 'handshake' | 'query' | 'close', timeoutMs: number, detail: string): Reply {
    const outcome = Atomics.wait(this.control, 0, STATE_WAITING, timeoutMs);
    if (outcome === 'timed-out') {
      this.shutDown(`a ${phase} wait timed out after ${timeoutMs} ms`);
      throw new PgBridgeTimeoutError(phase, timeoutMs, detail);
    }
    const state = Atomics.load(this.control, 0);
    const reply = receiveMessageOnPort(this.port)?.message as Reply | undefined;
    if (state === STATE_DEAD || reply?.dead) {
      const reason = reply?.error ? this.redact(reply.error.message) : 'no reason given';
      this.shutDown(`the worker died: ${reason}`);
      throw new PgWorkerDiedError(reason, reply?.error?.code);
    }
    if (!reply || reply.seq !== seq) {
      this.shutDown('protocol error');
      throw new PgWorkerDiedError(`protocol error: expected the reply to message ${seq}, got ${reply ? `message ${reply.seq}` : 'nothing'}`);
    }
    if (!reply.ok) {
      const message = this.redact(reply.error?.message ?? 'unknown error');
      if (phase === 'handshake') {
        this.shutDown(`the connection failed: ${message}`);
        throw new PgWorkerDiedError(`connecting failed: ${message}`, reply.error?.code);
      }
      throw new PgQueryError(message, reply.error?.code, reply.prefixFailed === true);
    }
    return reply;
  }

  private redact(message: string): string {
    return redactSecrets(message, this.secrets);
  }

  private shutDown(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.port.close();
    // terminate() stops the thread; its socket closes with it. The promise
    // settles after this synchronous caller returns, so it is only observed.
    void this.worker.terminate();
  }
}
