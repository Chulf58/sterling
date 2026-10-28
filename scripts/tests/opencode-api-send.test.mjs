import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiSend } from '../lib/opencode-api.mjs';

const send = (result) => {
  const calls = [];
  const api = async (...args) => (calls.push(args), result);
  return { calls, run: () => apiSend('POST', '/api/session', { a: 1 }, { bin: 'opencode', api }) };
};

test('apiSend: a failure that proves nothing was sent is not uncertain', async () => {
  const proven = [
    'OpenCode service file /x/service.json unreadable (ENOENT); is the shared OpenCode server running?',
    'OpenCode service password cannot be used in the child environment',
    'OpenCode API process could not start',
    'spawn opencode ENOENT',
    'Error: Could not reach server at http://127.0.0.1:1',
    'HTTP 400 Bad Request',
    'HTTP 404 Not Found',
  ];
  for (const stderr of proven) {
    const { run, calls } = send({ code: 1, stdout: '', stderr });
    const r = await run();
    assert.deepEqual([r.ok, r.uncertain], [false, false], stderr);
    assert.equal(calls.length, 1, 'one request, no retry');
  }
});

test('apiSend: a failure after the request may have been delivered is uncertain', async () => {
  const ambiguous = [
    { code: 1, stdout: '', stderr: 'read ECONNRESET' }, // connection reset after the send
    { code: 1, stdout: '', stderr: 'Error: fetch failed' },
    { code: 1, stdout: '', stderr: '' }, // killed by a signal: the runner reports code 1 with nothing on stderr
    { code: 1, stdout: '', stderr: 'HTTP 503 Service Unavailable' },
    { code: 1, stdout: '', stderr: 'bin api POST /x: reply is 99 bytes, over the 10-byte limit; not read' },
    { code: 124, stdout: '', stderr: 'opencode timed out after 30000 ms and was killed' },
  ];
  for (const result of ambiguous) {
    const { run, calls } = send(result);
    const r = await run();
    assert.deepEqual([r.ok, r.uncertain], [false, true], JSON.stringify(result));
    assert.equal(calls.length, 1, 'one request, no retry');
  }
});

test('apiSend: success returns the parsed body; an unusable success reply is uncertain', async () => {
  assert.deepEqual(await send({ code: 0, stdout: '{"data":{"id":"ses_a"}}', stderr: '' }).run(), { ok: true, data: { data: { id: 'ses_a' } } });
  const r = await send({ code: 0, stdout: 'not json', stderr: '' }).run();
  assert.deepEqual([r.ok, r.uncertain], [false, true]);
});
