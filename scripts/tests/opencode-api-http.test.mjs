import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lib from '../lib/opencode-api.mjs';

// createHttpApi: the in-process, read-only transport clear-project reads the shared OpenCode server through. A reply
// has the shape of opencodeApi ({ code, stdout, stderr }), so every caller of deps.api works unchanged. Each test runs
// against a loopback server of its own and a registration file in a temporary folder; nothing real is read.
// Board aedcf153: one `opencode api` process per request (its health check failing under load as
// "Could not reach server ... TimeoutError") made a dry-run take 7 to 12 minutes and fail.

const PASSWORD = 'pw-http-api-fixture';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

async function listen(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    handler(req, res, seen.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close };
}

async function withServer(handler, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'http-api-'));
  const s = await listen(handler);
  const file = join(dir, 'service.json');
  writeFileSync(file, JSON.stringify({ url: s.url, password: PASSWORD }), { mode: 0o600 });
  try {
    await fn({ file, seen: s.seen, dir, url: s.url });
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const json = (body) => (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body);

test('a GET is one authenticated in-process HTTP request and answers in the opencodeApi shape', async () => {
  await withServer(json('{"data":{}}'), async ({ file, seen }) => {
    const api = lib.createHttpApi({ serviceFile: file });
    assert.deepEqual(await api('GET', '/api/session/active', undefined, 10_000), { code: 0, stdout: '{"data":{}}', stderr: '' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/api/session/active');
    assert.equal(seen[0].auth, AUTH);
  });
});

test('an error status is code 1 with the status line on stderr and the body on stdout, as the CLI answers; stderr never carries the body or the password', async () => {
  const body = JSON.stringify({ _tag: 'LocationNotFoundError', message: `echo ${PASSWORD} /gone` });
  await withServer((req, res) => res.writeHead(404, 'Not Found').end(body), async ({ file }) => {
    const r = await lib.createHttpApi({ serviceFile: file })('GET', '/api/shell?x=1');
    // The clear gate reads a removed folder's LocationNotFoundError from stdout and the status from the first stderr line.
    assert.deepEqual(r, { code: 1, stdout: body, stderr: 'HTTP 404 Not Found' });
    assert.ok(!r.stderr.includes(PASSWORD));
  });
});

test('a request that outlives the per-request cap fails with code 124 at the cap whatever time the caller left; a shorter caller deadline wins', async () => {
  await withServer(() => {}, async ({ file, seen }) => {
    const api = lib.createHttpApi({ serviceFile: file, requestTimeoutMs: 120 });
    let t0 = performance.now();
    const capped = await api('GET', '/api/session?limit=1000', undefined, 600_000);
    assert.equal(capped.code, 124);
    assert.equal(capped.stdout, '');
    assert.equal(capped.stderr, 'timed out after 120 ms');
    assert.ok(performance.now() - t0 < 5_000, 'the cap, not the caller\'s ten minutes');
    t0 = performance.now();
    const shorter = await api('GET', '/api/session/active', undefined, 40);
    assert.equal(shorter.code, 124);
    assert.equal(shorter.stderr, 'timed out after 40 ms');
    assert.equal(seen.length, 2, 'a timeout is never retried');
  });
});

test('a slow GET and a failed GET are named in fixed words; a fast one and a plain HTTP answer are not', async () => {
  await withServer((req, res) => {
    if (req.url === '/slow') setTimeout(() => res.end('{}'), 120);
    else if (req.url === '/gone') res.writeHead(404, 'Not Found').end('{"_tag":"LocationNotFoundError"}');
    else if (req.url === '/hang') return;
    else res.end('{}');
  }, async ({ file }) => {
    const lines = [];
    const api = lib.createHttpApi({ serviceFile: file, slowMs: 60, requestTimeoutMs: 150, log: (l) => lines.push(l) });
    await api('GET', '/fast');
    assert.deepEqual(lines, []);
    await api('GET', '/gone');
    assert.deepEqual(lines, [], 'a 404 is an answer the gate reads, not a failed GET');
    await api('GET', '/slow');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^slow GET \/slow took 0\.\d s$/);
    await api('GET', '/hang');
    assert.equal(lines[1], 'GET /hang failed: timed out after 150 ms');
    assert.equal(lines.length, 2);
  });
});

test('the log and the summary never carry a reply body, the password or a cursor value', async () => {
  await withServer((req, res) => setTimeout(() => res.writeHead(500).end(`boom ${PASSWORD}`), 80), async ({ file }) => {
    const lines = [];
    const api = lib.createHttpApi({ serviceFile: file, slowMs: 20, log: (l) => lines.push(l) });
    await api('GET', '/api/session?limit=1000&cursor=SECRETCURSORVALUE');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^slow GET \/api\/session\?limit=1000&cursor=… took 0\.\d s$/);
    for (const text of [...lines, api.summary()]) {
      assert.ok(!text.includes(PASSWORD), text);
      assert.ok(!text.includes('SECRETCURSORVALUE'), text);
    }
  });
});

test('the summary counts the requests and names the slowest GET', async () => {
  await withServer((req, res) => (req.url === '/slowest' ? setTimeout(() => res.end('{}'), 100) : res.end('{}')), async ({ file }) => {
    const api = lib.createHttpApi({ serviceFile: file });
    assert.equal(api.summary(), '', 'nothing read, nothing to say');
    await api('GET', '/a');
    await api('GET', '/slowest');
    await api('GET', '/b');
    assert.match(api.summary(), /^3 GETs, \d+\.\d s of request time in all; the slowest was GET \/slowest, \d\.\d s$/);
  });
});

test('only GET is sent: any other method fails loudly and nothing reaches the server', async () => {
  await withServer(json('{}'), async ({ file, seen }) => {
    const api = lib.createHttpApi({ serviceFile: file });
    const r = await api('POST', '/api/session/ses_a/prompt', '{"text":"x"}', 1000);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /only GET/);
    assert.deepEqual(seen, []);
  });
});

test('a reply over the size cap is a failed read with no data', async () => {
  await withServer((req, res) => res.end('x'.repeat(1000)), async ({ file, seen }) => {
    const r = await lib.createHttpApi({ serviceFile: file, maxBytes: 100 })('GET', '/big');
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /reply larger than 100 bytes/);
    assert.equal(seen.length, 1, 'an oversized reply is never retried');
  });
});

test('no registration is a failed read and no request is made; the registration is read afresh for every call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'http-api-reg-'));
  const a = await listen(json('{"from":"a"}'));
  const b = await listen(json('{"from":"b"}'));
  try {
    const file = join(dir, 'service.json');
    const api = lib.createHttpApi({ serviceFile: file });
    const none = await api('GET', '/x');
    assert.equal(none.code, 1);
    assert.match(none.stderr, /service file/);
    writeFileSync(file, JSON.stringify({ url: a.url, password: PASSWORD }));
    assert.equal((await api('GET', '/x')).stdout, '{"from":"a"}');
    writeFileSync(file, JSON.stringify({ url: b.url, password: PASSWORD }));
    assert.equal((await api('GET', '/x')).stdout, '{"from":"b"}', 'a restarted server is picked up');
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    writeFileSync(file, JSON.stringify({ url: 'http://example.com:80', password: PASSWORD }));
    const remote = await api('GET', '/x');
    assert.equal(remote.code, 1, 'the password is only ever sent to a loopback server');
    assert.match(remote.stderr, /loopback/);
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default registration is the one opencodeApi reads: $XDG_STATE_HOME/opencode/service.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'http-api-xdg-'));
  const s = await listen(json('{"ok":true}'));
  const saved = process.env.XDG_STATE_HOME;
  try {
    mkdirSync(join(dir, 'opencode'));
    writeFileSync(join(dir, 'opencode', 'service.json'), JSON.stringify({ url: s.url, password: PASSWORD }), { mode: 0o600 });
    process.env.XDG_STATE_HOME = dir;
    assert.equal((await lib.createHttpApi()('GET', '/x')).stdout, '{"ok":true}');
    assert.equal(s.seen[0].auth, AUTH);
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection reset before any reply is retried for a GET; three resets exhaust its attempts with a fixed message', async () => {
  let resets = 1;
  await withServer((req, res) => {
    if (resets > 0) {
      resets--;
      req.socket.destroy();
      return;
    }
    res.end('{"ok":1}');
  }, async ({ file, seen }) => {
    const api = lib.createHttpApi({ serviceFile: file });
    assert.equal((await api('GET', '/x')).stdout, '{"ok":1}');
    assert.equal(seen.length, 2);
    resets = 3;
    const failed = await api('GET', '/y');
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /^could not reach the server \([A-Z_]+\)$/);
    assert.equal(seen.length, 5, 'three attempts, no more');
  });
});

test('a redirect is never followed, so the password cannot be sent to another host', async () => {
  const other = await listen(json('{}'));
  try {
    await withServer((req, res) => res.writeHead(302, { location: `${other.url}/x` }).end(), async ({ file }) => {
      const r = await lib.createHttpApi({ serviceFile: file })('GET', '/x');
      assert.equal(r.code, 1);
      assert.deepEqual(other.seen, []);
    });
  } finally {
    await other.close();
  }
});

test('readCapped: the text of a body, empty for none, and null once it passes the cap, the rest never read', async () => {
  assert.equal(await lib.readCapped(new Response('hello'), 100), 'hello');
  assert.equal(await lib.readCapped(new Response(null), 100), '');
  let cancelled = false;
  const endless = new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(8)), cancel: () => { cancelled = true; } });
  assert.equal(await lib.readCapped(new Response(endless), 20), null);
  assert.equal(cancelled, true);
});
