import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeApi } from '../lib/opencode-api.mjs';

const url = 'http://127.0.0.1:12345';
// OpenCode a517687: services/server-connection.ts connectError, rendered by
// cli/src/index.ts through Cause.pretty on stderr. Stack/cause details may follow.
const connectFailure = `Error: Could not reach server at ${url}\n    at connectError (server-connection.ts:95:12)\n  [cause]: Transport: The operation timed out\n`;

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-api-retry-'));
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  mkdirSync(join(dir, 'opencode'));
  writeFileSync(join(dir, 'opencode', 'service.json'), JSON.stringify({ url, password: 'fixture-only' }));
  const count = join(dir, 'count');
  writeFileSync(count, '0');
  const bin = join(dir, 'fake');
  const setup = (body) => {
    writeFileSync(bin, `#!/bin/bash\nn=$(cat '${count}'); n=$((n+1)); echo "$n" > '${count}'\n${body}\n`);
    chmodSync(bin, 0o755);
  };
  const attempts = () => Number(readFileSync(count, 'utf8'));
  try {
    await run({ bin, setup, attempts });
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
const fail = (stderr = connectFailure, code = 1) => `printf '%s' '${stderr}' >&2; exit ${code}`;

test('GET retries a CLI health transport failure and succeeds on attempt two', () => fixture(async ({ bin, setup, attempts }) => {
  setup(`if [ "$n" = 1 ]; then ${fail()}; fi\nprintf '%s' '{"ok":true}'`);
  assert.deepEqual(await opencodeApi(bin, 'get', '/api/session'), { code: 0, stdout: '{"ok":true}', stderr: '' });
  assert.equal(attempts(), 2);
}));

test('GET stops at three health failures and returns the last result unchanged', () => fixture(async ({ bin, setup, attempts }) => {
  setup(`printf 'Error: Could not reach server at ${url}\\nTransport: attempt %s\\n' "$n" >&2; exit "$n"`);
  assert.deepEqual(await opencodeApi(bin, 'GET', '/api/session'), { code: 3, stdout: '', stderr: `Error: Could not reach server at ${url}\nTransport: attempt 3\n` });
  assert.equal(attempts(), 3);
}));

for (const method of ['POST', 'PATCH', 'DELETE', 'PUT', 'HEAD']) {
  test(`${method} never retries even a CLI health transport failure`, () => fixture(async ({ bin, setup, attempts }) => {
    setup(fail());
    assert.deepEqual(await opencodeApi(bin, method, '/api/session'), { code: 1, stdout: '', stderr: connectFailure });
    assert.equal(attempts(), 1);
  }));
}

for (const stderr of [
  'HTTP 503 Service Unavailable\n',
  `Error: Server at ${url} rejected the password\n`,
  `Error: Server at ${url} did not provide a compatible V2 health response\n`,
  `Error: Could not reach server at ${url}/other\n`,
  `fetch failed: Could not reach server at ${url}\n`,
  `Error: request failed\nError: Could not reach server at ${url}\n`,
]) {
  test(`GET does not retry another diagnostic: ${stderr.trim()}`, () => fixture(async ({ bin, setup, attempts }) => {
    setup(fail(stderr));
    assert.deepEqual(await opencodeApi(bin, 'GET', '/api/session'), { code: 1, stdout: '', stderr });
    assert.equal(attempts(), 1);
  }));
}

test('GET exit 124 never retries even with the health diagnostic', () => fixture(async ({ bin, setup, attempts }) => {
  setup(fail(connectFailure, 124));
  assert.equal((await opencodeApi(bin, 'GET', '/api/session')).code, 124);
  assert.equal(attempts(), 1);
}));

test('GET with unparseable output is returned without retry', () => fixture(async ({ bin, setup, attempts }) => {
  setup(`printf 'not JSON'`);
  assert.deepEqual(await opencodeApi(bin, 'GET', '/api/session'), { code: 0, stdout: 'not JSON', stderr: '' });
  assert.equal(attempts(), 1);
}));

test('no retry starts when the backoff would use the remaining deadline', () => fixture(async ({ bin, setup, attempts }) => {
  setup(fail());
  const started = performance.now();
  assert.deepEqual(await opencodeApi(bin, 'GET', '/api/session', undefined, 150), { code: 1, stdout: '', stderr: connectFailure });
  assert.equal(attempts(), 1);
  assert.ok(performance.now() - started < 1000);
}));

test('a retry gets only the remaining overall timeout budget', () => fixture(async ({ bin, setup, attempts }) => {
  setup(`if [ "$n" = 1 ]; then ${fail()}; fi\nexec sleep 5`);
  const started = performance.now();
  const result = await opencodeApi(bin, 'GET', '/api/session', undefined, 800);
  assert.equal(result.code, 124);
  assert.equal(attempts(), 2);
  const budget = Number(result.stderr.match(/timed out after (\d+) ms/)[1]);
  assert.ok(budget > 0 && budget < 600, `retry budget was ${budget}`);
  assert.ok(performance.now() - started < 1500, 'deadline was renewed for the retry');
}));

test('a response body prevents retry even if stderr contains the health diagnostic', () => fixture(async ({ bin, setup, attempts }) => {
  setup(`printf 'response body'; ${fail()}`);
  assert.deepEqual(await opencodeApi(bin, 'GET', '/api/session'), { code: 1, stdout: 'response body', stderr: connectFailure });
  assert.equal(attempts(), 1);
}));
