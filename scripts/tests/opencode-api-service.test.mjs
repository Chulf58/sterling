import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readService } from '../lib/opencode-api.mjs';

test('the service file must exist, name a loopback http URL and carry a password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heist-svc-'));
  try {
    const f = join(dir, 's.json');
    assert.throws(() => readService(f), /unreadable/);
    for (const url of ['http://evil.example:1', 'https://127.0.0.1:1', 'http://127.0.0.1', 'http://127.0.0.1:1/path']) {
      writeFileSync(f, JSON.stringify({ url, password: 'p' }));
      assert.throws(() => readService(f), /loopback/, url);
    }
    writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:5' }));
    assert.throws(() => readService(f), /no password/);
    writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:5/', password: 'p' }));
    assert.deepEqual(readService(f), { url: 'http://127.0.0.1:5', password: 'p' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
