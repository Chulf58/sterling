// H7 stores the hook payload's agent_id on a touch record, as a MEASUREMENT
// instrument only (decision h22-dispatch-files-from-review-territory-and-
// resume-inherits-prior-round, 2026-10-02 amendment): a later live run reads
// touches.json to learn whether a subagent's PostToolUse Write/Edit carries
// agent_id. No consumer reads the field.
//   - a payload with a non-empty string agent_id stores it on the record
//   - a payload without one (absent, empty, non-string) stores {path, at} with NO agent_id key
//   - H7 stays append-only, so two agents touching one path leave two records
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H7 = join(root, 'scripts', 'hooks', 'h7-file-touch.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h7-agent-id-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return {
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function touch(dir, rel, extra = {}) {
  const r = spawnSync(process.execPath, [H7], {
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: join(dir, 't', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, rel) },
      ...extra,
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
}

const readTouches = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));

test('a touch whose payload carries a non-empty agent_id stores it on the record', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs', { agent_id: 'agent-abc123' });
    const touches = readTouches(dir);
    assert.equal(touches.length, 1);
    assert.equal(touches[0].path, 'src/a.mjs');
    assert.equal(touches[0].agent_id, 'agent-abc123');
    assert.equal(typeof touches[0].at, 'string');
  } finally {
    cleanup();
  }
});

test('a touch without agent_id has no agent_id key at all (absent, empty and non-string payload values)', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    touch(dir, 'src/b.mjs', { agent_id: '' });
    touch(dir, 'src/c.mjs', { agent_id: 42 });
    touch(dir, 'src/d.mjs', { agent_id: null });
    const touches = readTouches(dir);
    assert.deepEqual(touches.map((t) => t.path), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs']);
    for (const t of touches) {
      assert.deepEqual(Object.keys(t).sort(), ['at', 'path'], `record for ${t.path} is exactly {path, at}`);
    }
  } finally {
    cleanup();
  }
});

test('H7 stays append-only: two agents touching one path leave two records, each with its own agent_id', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs', { agent_id: 'agent-one' });
    touch(dir, 'src/a.mjs', { agent_id: 'agent-two' });
    touch(dir, 'src/a.mjs');
    const touches = readTouches(dir);
    assert.deepEqual(touches.map((t) => t.agent_id), ['agent-one', 'agent-two', undefined]);
  } finally {
    cleanup();
  }
});
