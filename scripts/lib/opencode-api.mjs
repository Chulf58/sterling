// An `opencode api` call, with its stdout written to a private temp file instead of a pipe.
//
// opencode 2.0.23 exits before a large reply has drained into a pipe: a 2.5 MB message page
// read through a pipe came back cut at 320 KB to 660 KB with exit code 0, while the same
// call redirected to a file was whole every time. A cut reply is not JSON, so every reader
// failed loud on it (the watcher stopped after five ticks). A regular file takes the writes
// at once, so nothing is left behind when the process exits. The file is unlinked before the
// child starts (see opencodeApi), so no reply stays on disk.
//
// The result has the shape of a run(): { code, stdout, stderr }, code 124 when
// timeoutMs ran out. The binary stays in the caller's process group, so Ctrl-C at the terminal
// reaches it as before. A timeout kills it, stops reading its stderr and settles at once,
// without waiting for stderr to close, which a leftover descendant could hold open.
// stderr keeps at most its last MAX_STDERR characters.
//
// createHttpApi (below) is the other transport, for a script that only reads: the same result
// shape, one in-process HTTP GET instead of one `opencode api` process per request.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

// The shared server (`opencode serve --service`) registers itself in service.json as
// { id, version, url, pid, password } (mode 0600) and accepts HTTP Basic auth with the user
// `opencode` and that password. The URL must be loopback http, so the password is never sent anywhere else.
export function readService(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`OpenCode service file ${file} unreadable (${err.code ?? 'read error'}); is the shared OpenCode server running?`);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    // Never JSON.parse's message: it quotes bytes of the file, and the file holds the password.
    throw new Error(`OpenCode service file ${file} is not valid JSON`);
  }
  const url = typeof s?.url === 'string' ? s.url.replace(/\/+$/, '') : '';
  if (!LOOPBACK.test(url)) throw new Error(`OpenCode service file ${file}: url is not a loopback http URL`);
  if (typeof s.password !== 'string' || !s.password) throw new Error(`OpenCode service file ${file} has no password`);
  return { url, password: s.password };
}

// The body as text, or null once it grows past maxBytes (the rest is cancelled, not read).
export async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      // The read has already failed on size; a cancel error changes nothing about that.
      await res.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const MAX_STDERR = 1024 * 1024;
// The old runner's maxBuffer: a larger reply is a failed call, never read into memory.
export const MAX_STDOUT = 64 * 1024 * 1024;

// The registration of the running shared server, read afresh by every call of either transport.
const serviceFilePath = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'service.json');

// Pass CLI configuration and platform settings, not unrelated service credentials.
const CLI_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_.*|TZ|TMPDIR|TMP|TEMP|XDG_.*|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|OPENCODE_.*)$/;

function runToFile(bin, args, fd, timeoutMs, password) {
  return new Promise((resolve) => {
    let child;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'OPENCODE_PASSWORD' && CLI_ENV.test(key)));
      env.OPENCODE_PASSWORD = password;
      child = spawn(bin, args, { stdio: ['ignore', fd, 'pipe'], env });
    } catch {
      // Node's synchronous argument/environment errors can quote credential bytes.
      resolve({ code: 1, stderr: 'OpenCode API process could not start' });
      return;
    }
    let stderr = '';
    let cut = false;
    let timer = null;
    let settled = false;
    const keepTail = () => {
      if (stderr.length > MAX_STDERR) {
        stderr = stderr.slice(-MAX_STDERR);
        cut = true;
      }
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      keepTail();
      resolve({ ...result, stderr: result.stderr ?? (cut ? `[stderr cut to its last ${MAX_STDERR} characters]\n${stderr}` : stderr) });
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      stderr += s;
      if (stderr.length > 2 * MAX_STDERR) keepTail();
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stderr.destroy();
        settle({ code: 124, stderr: `${bin} timed out after ${timeoutMs} ms and was killed` });
      }, timeoutMs);
    }
    child.on('error', (e) => settle({ code: 1, stderr: String(e.message) }));
    child.on('close', (code) => settle({ code: typeof code === 'number' ? code : 1 }));
  });
}

// The whole file from offset 0, through the read descriptor opened before the unlink.
async function readAll(reader, size) {
  const buf = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await reader.read(buf, at, size - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return buf.subarray(0, at).toString('utf8');
}

// The reply file is opened twice (one descriptor for the child's stdout, one to read it back)
// and then unlinked with its directory before the child starts. The reply lives only as long
// as the descriptors, so a caller ended by a signal leaves nothing on disk.
export async function opencodeApi(bin, method, path, body, timeoutMs = 0, { maxStdout = MAX_STDOUT } = {}) {
  const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
  // An explicit server bypasses Service.ensure and its slow-health-check recovery,
  // which can kill the shared server. Read its registration afresh; never fall back
  // to managed-service discovery. The existing reader validates loopback and keeps
  // registration bytes (including the password) out of errors and command arguments.
  let service;
  try {
    service = readService(serviceFilePath());
  } catch (err) {
    return { code: 1, stdout: '', stderr: err.message };
  }
  // readService guarantees a nonempty string; NUL is the remaining value Node
  // rejects for an environment entry. Never let its exception quote the password.
  if (service.password.includes('\0')) {
    return { code: 1, stdout: '', stderr: 'OpenCode service password cannot be used in the child environment' };
  }
  const args = ['api', method.toLowerCase(), path, ...(body === undefined ? [] : ['-d', body]), '--server', service.url];
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) return result ?? { code: 124, stdout: '', stderr: `${bin} timed out after ${timeoutMs} ms and was killed` };
    result = await runAttempt(bin, args, method, path, timeoutMs, deadline, service.password, maxStdout);
    // OpenCode v2.1.2 connectError emits this only for a failed transport in
    // its pre-request health check. Never retry a request timeout or mutation.
    const diagnostic = `Error: Could not reach server at ${service.url}`;
    if (method.toUpperCase() !== 'GET' || result.code === 0 || result.code === 124
      || result.stdout !== '' || result.stderr.split('\n')[0] !== diagnostic || attempt === 2) return result;
    const delay = [250, 1000][attempt];
    if (performance.now() + delay >= deadline) return result;
    await sleep(delay);
  }
}

// The reply file pair: opened twice (one descriptor for the child's stdout, one to read it back), then unlinked
// with its directory, so the reply lives only as long as the descriptors. This function owns both handles until it
// returns them: any failure, the unlink of the folder included, closes every handle it opened before it rejects, so
// a caller never holds a half-prepared pair it could not discard. `fs` is a seam for tests.
export async function replyFiles(fs = {}) {
  const { mkdtemp: makeDir = mkdtemp, open: openFile = open, rm: remove = rm } = fs;
  const dir = await makeDir(join(tmpdir(), 'sterling-api-'));
  const handles = [];
  let removed = false;
  try {
    handles.push(await openFile(join(dir, 'stdout'), 'w', 0o600));
    handles.push(await openFile(join(dir, 'stdout'), 'r'));
    removed = true; // one removal attempt only: a failed one is not repeated below
    await remove(dir, { recursive: true, force: true });
    return { out: handles[0], reader: handles[1] };
  } catch (e) {
    const cleanup = await Promise.allSettled([...handles.map((h) => h.close()), ...(removed ? [] : [remove(dir, { recursive: true, force: true })])]);
    const failed = cleanup.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failed.length > 0) throw new AggregateError([e, ...failed], `preparing the reply files failed (${e.message}), and so did cleaning them up`);
    throw e;
  }
}

// Runs the child into prepared reply files and reads the reply back; closes the files whatever happens.
// runToFile spawns synchronously when it is called, so a caller's first await here is the request itself.
async function runPrepared(bin, args, method, path, timeoutMs, deadline, password, maxStdout, files) {
  const { out, reader } = files;
  try {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) return { code: 124, stdout: '', stderr: `${bin} timed out after ${timeoutMs} ms and was killed` };
    const result = await runToFile(bin, args, out.fd, Number.isFinite(remaining) ? remaining : 0, password);
    const { size } = await reader.stat();
    if (size > maxStdout) {
      const over = `${bin} api ${method.toUpperCase()} ${path}: reply is ${size} bytes, over the ${maxStdout}-byte limit; not read`;
      return { code: result.code !== 0 ? result.code : 1, stdout: '', stderr: result.stderr ? `${over}\n${result.stderr}` : over };
    }
    return { code: result.code, stdout: await readAll(reader, size), stderr: result.stderr };
  } finally {
    await out.close();
    await reader.close();
  }
}

async function runAttempt(bin, args, method, path, timeoutMs, deadline, password, maxStdout) {
  return runPrepared(bin, args, method, path, timeoutMs, deadline, password, maxStdout, await replyFiles());
}

/**
 * One `opencode api` call made ready ahead of time: the registration is read, the arguments are built and the reply
 * files are open. Returns { send, discard }. send() starts the child at once (its only await is the request itself;
 * the deadline counts from send()) and answers like opencodeApi; it never retries and runs once. discard() closes the
 * files of a call that will not be sent. A registration that cannot be used is answered by send() as opencodeApi
 * answers it, with nothing started.
 */
export async function prepareApiCall(bin, method, path, body, timeoutMs = 0, { maxStdout = MAX_STDOUT } = {}) {
  let service;
  try {
    service = readService(serviceFilePath());
  } catch (err) {
    return { send: async () => ({ code: 1, stdout: '', stderr: err.message }), discard: async () => {} };
  }
  if (service.password.includes('\0')) {
    return { send: async () => ({ code: 1, stdout: '', stderr: 'OpenCode service password cannot be used in the child environment' }), discard: async () => {} };
  }
  const args = ['api', method.toLowerCase(), path, ...(body === undefined ? [] : ['-d', body]), '--server', service.url];
  const files = await replyFiles();
  let used = false;
  return {
    send: () => {
      if (used) throw new Error('a prepared OpenCode API call runs once');
      used = true;
      const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
      return runPrepared(bin, args, method, path, timeoutMs, deadline, service.password, maxStdout, files);
    },
    discard: async () => {
      if (used) return;
      used = true;
      await files.out.close();
      await files.reader.close();
    },
  };
}

// The in-process transport for a script that only reads (inventory scans). On 2026-10-26 a dry-run
// made 176 to 224 requests in 148 to 629 s and one ended in a TimeoutError: each request was an `opencode api`
// process, its pre-request health check (one 5 s fetch) failed while the shared server was busy, the request
// after it had no deadline and nothing named the one that failed. Here a request is one fetch with Basic auth and a
// deadline of its own; a slow or failed one is named in `log`, in fixed words that carry no reply body, no password
// and no cursor value. GET only: nothing that changes the server goes through it.
//
// A call answers like opencodeApi, { code, stdout, stderr }:
//   - an HTTP error status is code 1 with the body on stdout and `HTTP <status> <reason>` on stderr, as the CLI answers
//     (a caller reads a removed folder's LocationNotFoundError from there);
//   - no answer in time is code 124, a reply over maxBytes or an unreachable server is code 1, each with a fixed stderr
//     and nothing on stdout. A caller that names the request (getJson) puts `GET <path> failed:` before it itself.
// The registration (url and password) is read afresh for every call and is never used for anything but a loopback
// address (readService).

// No request waits longer than this, whatever time the caller left: the gate's phases are budgeted in minutes. On 2026-10-26 one
// page of 1000 sessions took 49 s on the busy shared server, so the cap is more than twice that.
export const REQUEST_TIMEOUT_MS = 120_000;
// A request that takes at least this long is named in the log. On the same day about one request in four took 5 to 15 s, a
// trivial /api/session/active included, so a lower threshold printed dozens of lines for one run.
export const SLOW_GET_MS = 10_000;
// Only connection failures before an HTTP response may retry. Timeouts, HTTP statuses and body failures never do.
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

const seconds = (ms) => (ms / 1000).toFixed(1);
// A cursor is a long opaque token: a logged path carries `…` in its place.
const named = (path) => path.replace(/([?&]cursor=)[^&]*/g, '$1…');

export function createHttpApi({ serviceFile, fetchImpl = globalThis.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS, slowMs = SLOW_GET_MS, maxBytes = MAX_STDOUT, log = () => {} } = {}) {
  let gets = 0;
  let spent = 0;
  let slowest = null;

  // One request: its answer, or why it has none: 'timeout', 'over' (too large) or 'connect' with the error's code.
  async function once(url, authorization, ms) {
    const ac = new AbortController();
    let timedOut = false;
    let received = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ms);
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { authorization }, signal: ac.signal, redirect: 'error' });
      received = true;
      const text = await readCapped(res, maxBytes);
      return text === null ? { why: 'over' } : { res, text };
    } catch (err) {
      if (timedOut) return { why: 'timeout' };
      const code = String(err?.cause?.code ?? err?.code ?? '');
      return { why: 'connect', code: /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'UNKNOWN', retryable: !received && CONNECTION_CODES.has(code) };
    } finally {
      clearTimeout(timer);
    }
  }

  const api = async (method, path, _body, timeoutMs = 0) => {
    if (String(method).toUpperCase() !== 'GET') return { code: 1, stdout: '', stderr: `this transport sends only GET requests; ${method} was not sent` };
    if (typeof path !== 'string' || !path.startsWith('/')) return { code: 1, stdout: '', stderr: 'the request path must start with /' };
    let service;
    try {
      service = readService(serviceFile ?? serviceFilePath());
    } catch (err) {
      return { code: 1, stdout: '', stderr: err.message };
    }
    const ms = timeoutMs > 0 ? Math.min(timeoutMs, requestTimeoutMs) : requestTimeoutMs;
    const url = `${service.url}${path}`;
    const authorization = `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`;
    const t0 = performance.now();
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = Math.ceil(ms - (performance.now() - t0));
      if (left <= 0) {
        r = { why: 'timeout' };
        break;
      }
      r = await once(url, authorization, left);
      if (!r.retryable || attempt === 2) break;
      const delay = [250, 1000][attempt];
      if (performance.now() - t0 + delay >= ms) break;
      await sleep(delay);
    }
    const took = performance.now() - t0;
    gets++;
    spent += took;
    if (!slowest || took > slowest.took) slowest = { path: named(path), took };
    const failed = (reason, code, text) => {
      log(`GET ${named(path)} failed: ${reason}`);
      return { code, stdout: '', stderr: text ?? reason };
    };
    if (r.why === 'timeout') return failed(`timed out after ${ms} ms`, 124);
    if (r.why === 'over') return failed(`reply larger than ${maxBytes} bytes`, 1);
    if (r.why === 'connect') return failed(`could not reach the server (${r.code})`, 1);
    if (took >= slowMs) log(`slow GET ${named(path)} took ${seconds(took)} s`);
    return r.res.ok ? { code: 0, stdout: r.text, stderr: '' } : { code: 1, stdout: r.text, stderr: `HTTP ${r.res.status} ${r.res.statusText}`.trim() };
  };

  // One line for the end of a run: how many requests, their summed time, the slowest one.
  api.summary = () => (gets === 0 ? '' : `${gets} GET${gets === 1 ? '' : 's'}, ${seconds(spent)} s of request time in all; the slowest was GET ${slowest.path}, ${seconds(slowest.took)} s`);
  return api;
}

// The opencode binary: `opencode` on PATH, else ~/.opencode/bin/opencode (the installer's location).
export function defaultOpencodeBin({ pathVar = process.env.PATH ?? '', home = homedir(), exists = existsSync } = {}) {
  for (const dir of pathVar.split(delimiter)) if (dir && exists(join(dir, 'opencode'))) return join(dir, 'opencode');
  const installed = join(home, '.opencode', 'bin', 'opencode');
  return exists(installed) ? installed : 'opencode';
}

// Failures that prove no request left this process: the registration could not be used, the binary could not start,
// or the CLI's own pre-request health check failed. A server's 4xx is a proven rejection too. Anything else (a
// timeout, a reset after the send, a signal, a 5xx, an unusable reply) may have been delivered.
const NOT_SENT = [
  /^OpenCode service file /,
  /^OpenCode service password cannot be used/,
  /^OpenCode API process could not start/,
  /^spawn \S+ (ENOENT|EACCES|EPERM)\b/,
  /^Error: Could not reach server at /,
  /^HTTP 4\d\d\b/,
];
const provenNotSent = (stderr) => {
  const first = String(stderr ?? '').trimStart().split('\n')[0];
  return NOT_SENT.some((re) => re.test(first));
};

// What a mutating call's result means: { ok, data } or { ok: false, uncertain, why }. `uncertain` is false only when the
// failure proves the request was never accepted (provenNotSent); a timeout, a signal, a reset after the send, a 5xx or
// a success reply that is unusable are uncertain, so a caller must check before it sends again.
function sendOutcome(r) {
  const text = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim();
  if (r.code === 124) return { ok: false, uncertain: true, why: `timed out${text ? `: ${text}` : ''}` };
  if (r.code !== 0) return { ok: false, uncertain: !provenNotSent(r.stderr), why: `exit ${r.code}${text ? `: ${text}` : ''}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, uncertain: true, why: `the response was not JSON (${e.message})${text ? `: ${text}` : ''}` };
  }
}

/**
 * A mutating call made ready ahead of time, for a caller whose last check must be followed by the request with no
 * wait between (scripts/lib/owner-session.mjs): the transport is prepared here, and the returned send() starts it at
 * once. Returns { send, discard }; send() answers like apiSend, runs once and is never retried. An injected `api`
 * (tests) is called by send() as apiSend calls it.
 */
export async function prepareSend(method, path, body, { bin = defaultOpencodeBin(), api, prepare = prepareApiCall, timeoutMs = 30_000 } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (api) return { send: async () => sendOutcome(await api(bin, method, path, text, timeoutMs)), discard: async () => {} };
  const call = await prepare(bin, method, path, text, timeoutMs);
  return { send: async () => sendOutcome(await call.send()), discard: () => call.discard() };
}

// A mutating call: exactly one request, never retried (opencodeApi retries only a GET that never reached the
// server). A body is sent as JSON. Answers { ok, data, uncertain, why } (sendOutcome).
export async function apiSend(method, path, body, { bin = defaultOpencodeBin(), api = opencodeApi, timeoutMs = 30_000 } = {}) {
  return sendOutcome(await api(bin, method, path, body === undefined ? undefined : JSON.stringify(body), timeoutMs));
}
