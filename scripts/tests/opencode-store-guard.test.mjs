// The OpenCode store guard (packages/opencode-plugin/src/store-guard.mjs): the
// permission evaluate hook that denies shell, edit, write and patch requests on
// .sterling/sterling.db whatever the agent's own rules say (decision
// opencode-store-guard-uses-the-plugin-permission-evaluate-hook). The request shapes
// below are the ones OpenCode 2.0.22 passed to a probe plugin's evaluate hook, live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guard = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'store-guard.mjs')).href);
const server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);

/** An evaluate input as 2.0.22 builds it, with the verdict the agent's rules reached. */
const req = (action, resources, effect = 'allow') => ({ sessionID: 'ses_1', agent: 'probeagent', action, resources, metadata: {}, source: { type: 'tool' }, effect });

test('shell: each simple command naming the store is denied (live shapes: cd is dropped, a ; line is split)', () => {
  for (const resources of [
    ['ls -la .sterling/sterling.db'],
    ['cat sterling.db'], // `cd .sterling && cat sterling.db` reaches the hook as this
    ['cat x', 'rm .sterling/sterling.db'], // `cat x; rm .sterling/sterling.db`
    ['ls -la ./.sterling/../.sterling/sterling.db'],
    ['sqlite3 .sterling/sterling.db-wal .tables'],
    ['cp /tmp/evil .sterling/STERLING.DB'], // the case-insensitive file systems of Windows and macOS
    ["rm .sterling/sterling''.db"], // quotes the shell removes before the command runs
    ['cat sterl"ing.db"'],
    ['cat .sterling/sterling\\.db'],
  ]) {
    const p = req('shell', resources);
    guard.onEvaluate(p);
    assert.equal(p.effect, 'deny', JSON.stringify(resources));
    assert.equal(p.message, guard.STORE_GUARD_MESSAGE);
  }
});

test('shell: the bash action alias is guarded like shell', () => {
  const p = req('bash', ['sqlite3 .sterling/sterling.db']);
  guard.onEvaluate(p);
  assert.equal(p.effect, 'deny');
});

test('edit family: a Sterling domain store (~/.sterling/domains/<tag>/sterling.db) is denied, as H15 does', () => {
  for (const action of ['edit', 'write']) {
    for (const path of ['/home/u/.sterling/domains/node/sterling.db', '/home/u/.sterling/domains/typescript/sterling.db-wal', 'C:\\Users\\u\\.sterling\\domains\\sterling\\sterling.db-journal', '.sterling/backup/sterling.db.bak']) {
      const p = req(action, [path]);
      guard.onEvaluate(p);
      assert.equal(p.effect, 'deny', `${action} ${path}`);
    }
  }
  for (const path of ['/home/u/.sterling/domains/node/notes.md', '/home/u/.sterling/registry.json', '.sterling/sterling.dbx']) {
    const p = req('write', [path]);
    guard.onEvaluate(p);
    assert.equal(p.effect, 'allow', path);
  }
});

test('shell: commands on other .sterling/ files and unrelated commands keep their verdict', () => {
  for (const [resources, effect] of [
    [['cat .sterling/config.json'], 'allow'],
    [['ls .sterling/transient'], 'allow'],
    [['npm test'], 'ask'],
    [['rm -rf build'], 'deny'],
  ]) {
    const p = req('shell', resources, effect);
    guard.onEvaluate(p);
    assert.equal(p.effect, effect, JSON.stringify(resources));
    assert.equal(p.message, undefined);
  }
});

test('edit family: the store path in any spelling is denied (patch arrives as action edit with project-relative paths)', () => {
  for (const action of ['edit', 'write', 'patch']) {
    for (const path of [
      '.sterling/sterling.db',
      './.sterling/../.sterling/sterling.db',
      '.sterling//sterling.db',
      '/home/u/proj/.sterling/sterling.db',
      'C:\\Users\\u\\proj\\.sterling\\sterling.db',
      '.sterling/sterling.db-shm',
      '.Sterling/Sterling.db',
    ]) {
      const p = req(action, [path]);
      guard.onEvaluate(p);
      assert.equal(p.effect, 'deny', `${action} ${path}`);
    }
  }
  // A multi-file patch is denied when any one of its files is the store.
  const p = req('edit', ['src/a.ts', '.sterling/sterling.db']);
  guard.onEvaluate(p);
  assert.equal(p.effect, 'deny');
});

test('edit family: other .sterling/ files and look-alike names stay editable (H15: only the db is guarded)', () => {
  for (const path of ['.sterling/config.json', '.sterling/notes.txt', '.sterling/transient/log.txt', 'docs/sterling.db.md', 'sterling.db', 'x/sterling.db', '.sterling/sterling.db/inside', '.sterling-old/sterling.db']) {
    const p = req('edit', [path]);
    guard.onEvaluate(p);
    assert.equal(p.effect, 'allow', path);
  }
});

test('edit family: metadata.filepath naming the store is denied even when resources do not', () => {
  const p = { ...req('edit', ['src/a.ts']), metadata: { filepath: '.sterling/sterling.db' } };
  guard.onEvaluate(p);
  assert.equal(p.effect, 'deny');
});

test('other actions are untouched, including read of the store (reading is allowed)', () => {
  for (const action of ['read', 'grep', 'webfetch', 'external_directory']) {
    const p = req(action, ['.sterling/sterling.db']);
    guard.onEvaluate(p);
    assert.equal(p.effect, 'allow', action);
  }
});

test('fail closed: a guarded action whose resources are not an array of strings is denied with its own message', () => {
  for (const resources of [undefined, null, '.sterling/sterling.db', [{ path: 'x' }]]) {
    const p = req('shell', resources);
    guard.onEvaluate(p);
    assert.equal(p.effect, 'deny', JSON.stringify(resources));
    assert.match(p.message, /could not read/);
  }
  const p = req('read', undefined);
  guard.onEvaluate(p);
  assert.equal(p.effect, 'allow');
});

/** Just enough of the 2.0.22 plugin context for setup; `permission` is replaced per test. */
function stubCtx(directory, permission) {
  const noop = async () => ({ dispose: async () => {} });
  return {
    location: { directory },
    session: { hook: noop, get: async () => ({}) },
    tool: { hook: noop },
    command: { transform: noop },
    skill: { transform: noop },
    mcp: { transform: noop },
    permission,
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
}

test('setup registers the evaluate hook in every location, outside a Sterling project too, and in the maintenance-worker child', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-guard-'));
  try {
    // STERLING_MAINTENANCE_WORKER=1 is the worker child (scripts/hooks/lib/maintenance-worker.mjs WORKER_ENV_FLAG).
    for (const env of [{}, { STERLING_MAINTENANCE_WORKER: '1' }]) {
      const hooks = [];
      const plugin = server.createSterlingServer({ env, bootstrap: async () => {}, configure: async () => {} });
      const cleanup = await plugin.setup(stubCtx(dir, { hook: async (name, fn) => void hooks.push([name, fn]) }));
      assert.deepEqual(hooks.map(([n]) => n), ['evaluate']);
      const p = req('shell', ['cat sterling.db']);
      await hooks[0][1](p);
      assert.equal(p.effect, 'deny');
      cleanup?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup with no location still registers the evaluate hook before giving up on the location', async () => {
  const hooks = [];
  const plugin = server.createSterlingServer({ bootstrap: async () => {}, configure: async () => {} });
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const ctx = { ...stubCtx('/unused', { hook: async (name, fn) => void hooks.push([name, fn]) }), location: undefined };
    assert.equal(await plugin.setup(ctx), undefined);
  } finally {
    process.stderr.write = orig;
  }
  assert.deepEqual(hooks.map(([n]) => n), ['evaluate']);
  const p = req('edit', ['.sterling/sterling.db']);
  await hooks[0][1](p);
  assert.equal(p.effect, 'deny');
});

test('setup without ctx.permission.hook inside a Sterling project logs it and raises a notice naming the unguarded project agent files', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-guard-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), ''); // marks a Sterling project (projectRoot); never opened here
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const plugin = server.createSterlingServer({ bootstrap: async () => {}, configure: async () => {} });
    const cleanup = await plugin.setup(stubCtx(dir, undefined));
    cleanup?.();
    const log = readFileSync(join(dir, server.LOG_REL), 'utf8');
    assert.match(log, /store guard: .*no ctx\.permission\.hook/);
    const notices = readFileSync(join(dir, server.NOTICES_REL), 'utf8');
    assert.match(notices, /store guard .*NOT registered/);
    assert.match(notices, /project agent files .*own shell or edit rules .*unguarded/);
  } finally {
    process.stderr.write = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup without ctx.permission.hook says the store guard is missing on stderr and still registers the rest', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-guard-'));
  const written = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => (written.push(String(s)), true);
  try {
    let booted = false;
    const plugin = server.createSterlingServer({ bootstrap: async () => void (booted = true) });
    const cleanup = await plugin.setup(stubCtx(dir, undefined));
    assert.equal(booted, true);
    assert.ok(written.some((s) => /store guard/.test(s) && /permission\.hook/.test(s)), written.join(''));
    cleanup?.();
  } finally {
    process.stderr.write = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
