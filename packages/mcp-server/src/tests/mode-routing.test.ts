// The MCP server's half of store routing (issue Chulf58/sterling#26 item 5;
// decision storage-backend-is-its-own-config-key-written-only-by-store-move):
// --project routes by config.storage, --store stays the SQLite form and refuses
// a project whose storage is 'postgres', a Postgres boot that cannot reach its
// stores fails by name and writes nothing, and config_set refuses `storage`
// while `mode` stays writable.
//
// The stdio boot smoke against Served needs STERLING_TEST_PG=1; it creates its
// stores under its own sterling_test_<random> namespace and drops them after.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PgBridge, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';
import { createSterlingServer, StoreArgInPostgresStorageError } from '../server.js';

const mainJs = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `sterling-mode-routing-${label}-`));
  dirs.push(d);
  return d;
}

function project(config: Record<string, unknown>, identity?: string): string {
  const root = tempDir('project');
  mkdirSync(join(root, '.sterling'));
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  if (identity !== undefined) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: identity }));
  return root;
}

function homeWithCredentials(creds: Record<string, unknown>): string {
  const home = tempDir('home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const path = join(home, '.sterling', 'credentials', 'served.json');
  writeFileSync(path, JSON.stringify(creds));
  chmodSync(path, 0o600);
  return home;
}

async function connect(root: string) {
  const { server, store } = createSterlingServer(join(root, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'mode-routing-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); store.close(); } };
}

for (const path of ['storage', 'storage.backend']) {
  test(`config_set refuses a plain write of '${path}' by name, pointing at move-store, and writes nothing`, async () => {
    const root = project({ mode: 'work' });
    const before = readFileSync(join(root, '.sterling', 'config.json'), 'utf8');
    const { client, close } = await connect(root);
    try {
      const r = await client.callTool({ name: 'config_set', arguments: { path, value: 'postgres' } });
      assert.equal(r.isError, true);
      const text = (r.content as { text: string }[])[0].text;
      assert.match(text, /cannot be written directly/);
      assert.match(text, /explicit storage transition/);
      assert.match(text, /node scripts\/move-store\.mjs --to pg\|sqlite/, 'the refusal names the command that moves the stores');
      assert.equal(readFileSync(join(root, '.sterling', 'config.json'), 'utf8'), before, 'nothing was written');
    } finally {
      await close();
    }
  });
}

test('config_set writes mode: it is the PR-flow toggle, not the storage backend', async () => {
  const root = project({ mode: 'hobby' });
  const { client, close } = await connect(root);
  try {
    const r = await client.callTool({ name: 'config_set', arguments: { path: 'mode', value: 'work' } });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    assert.equal(JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8')).mode, 'work');
  } finally {
    await close();
  }
});

test("--store form: storage 'postgres' is refused by name and no SQLite file is created", () => {
  const root = project({ mode: 'work', storage: 'postgres' }, randomUUID());
  assert.throws(() => createSterlingServer(join(root, '.sterling', 'sterling.db')), StoreArgInPostgresStorageError);
  assert.deepEqual(readdirSync(join(root, '.sterling')).sort(), ['config.json', 'project.json']);
});

test('--store form: a work-mode project with no storage key opens its SQLite store as before', () => {
  const root = project({ mode: 'work' });
  const { store } = createSterlingServer(join(root, '.sterling', 'sterling.db'));
  try {
    assert.ok(existsSync(join(root, '.sterling', 'sterling.db')));
  } finally {
    store.close();
  }
});

test('main.ts: --project resolves the root and anchors the local .sterling/ under it', () => {
  const root = project({});
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, `import { projectRoot, storePath } from ${JSON.stringify(pathToFileURL(mainJs).href)};\nprocess.stdout.write(JSON.stringify({ projectRoot, storePath }));\nprocess.exit(0);\n`);
  const r = spawnSync(process.execPath, [probe, '--project', '.'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { projectRoot: string; storePath: string };
  assert.equal(out.projectRoot, root);
  assert.equal(out.storePath, join(root, '.sterling', 'sterling.db'));
});

test('main.ts: neither or both of --project and --store is a usage error', () => {
  for (const args of [[], ['--project', '/a', '--store', '/b/.sterling/sterling.db'], ['--project']]) {
    const r = spawnSync(process.execPath, [mainJs, ...args], { input: '', encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, /usage: sterling-mcp --project/);
  }
});

test('main.ts: an unexpanded placeholder in --project is refused', () => {
  const cwd = tempDir('cwd');
  const r = spawnSync(process.execPath, [mainJs, '--project', '${CLAUDE_PROJECT_DIR}'], { cwd, input: '', encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--project path contains an unexpanded placeholder/);
  assert.deepEqual(readdirSync(cwd), []);
});

test("main.ts: a storage 'postgres' boot with the database unreachable fails by name and writes nothing", () => {
  const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['alpha'] }, randomUUID());
  const home = homeWithCredentials({ host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', mainJs, '--project', root], {
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /^sterling-mcp: StoreUnreachableError: storage 'postgres': the Postgres store database at 127\.0\.0\.1:1\/app is unreachable/m);
  assert.match(r.stderr, /never falls back to SQLite/);
  assert.doesNotMatch(r.stderr, /not-a-secret/);
  assert.deepEqual(readdirSync(join(root, '.sterling')).sort(), ['config.json', 'project.json'], 'no SQLite file, no runtime marker, nothing written');
});

// ---------------------------------------------------------------------------
// Boot smoke over stdio against Served (STERLING_TEST_PG=1)
// ---------------------------------------------------------------------------

const PG = process.env.STERLING_TEST_PG === '1';

test("main.ts --project with storage 'postgres': one knowledge_query round trip over stdio against sterling_test_ stores", { skip: PG ? false : 'set STERLING_TEST_PG=1 to run against Served' }, async () => {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const id = randomUUID();
  const projectSchema = `${ns}_p_${id.replace(/-/g, '')}`;
  const bridge = new PgBridge(readPgCredentials());
  try {
    ensurePgLayout(bridge, `${ns}_meta`);
    createPgStore(bridge, { kind: 'test', name: 'smoke project', schema: projectSchema, metaSchema: `${ns}_meta` });
    createPgStore(bridge, { kind: 'test', name: 'alpha', schema: `${ns}_d_alpha`, metaSchema: `${ns}_meta` });
    const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['alpha'] }, id);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', mainJs, '--project', root],
      env: { ...(process.env as Record<string, string>), STERLING_TEST_PG_NAMESPACE: ns },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mode-routing-smoke', version: '0.0.1' });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: 'knowledge_query', arguments: {} });
      assert.notEqual(r.isError, true, JSON.stringify(r.content));
      const body = JSON.parse((r.content as { text: string }[])[0].text) as Record<string, unknown>;
      assert.ok(body && typeof body === 'object', 'knowledge_query answered with a JSON object');
    } finally {
      await client.close();
    }
    assert.equal(existsSync(join(root, '.sterling', 'sterling.db')), false, 'Postgres storage created no SQLite file');
  } finally {
    try {
      const rows = bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows;
      for (const row of rows) bridge.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
    } finally {
      bridge.close();
    }
  }
});
