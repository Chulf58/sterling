// --read-only (read-only.ts): the server agy's 'sterling-ro' entry starts for the
// read-only roles (decision antigravity-cli-agy-read-only-role-guard-read-the-agent-role).
// Every tool in the shared store-write list refuses and writes nothing, reads keep
// working, and an empty or unreadable list refuses boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';
import { readOnlyWriteTools } from '../read-only.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tests -> the repo root, where agent-templates/implementor.md lives.
const repoRoot = resolve(here, '..', '..', '..', '..');
const MAIN = join(here, '..', 'main.js');

/** Every mcp__sterling__<tool> in implementor.md's disallowedTools, read independently of the shared reader. */
function templateWriteTools(): string[] {
  const fm = readFileSync(join(repoRoot, 'agent-templates', 'implementor.md'), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const line = fm.match(/^disallowedTools:\s*(.+)$/m)?.[1] ?? '';
  return [...new Set([...line.matchAll(/mcp__sterling__(\w+)/g)].map((m) => m[1]))];
}

type CallResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connect(server: ReturnType<typeof createSterlingServer>['server']): Promise<Client> {
  const client = new Client({ name: 'read-only-mode-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('one store-write list: the read-only server and the OpenCode permissions read the same names from the implementor template', async () => {
  // opencode-install.d.mts does not declare storeWriteTools, so it is imported untyped.
  const { storeWriteTools } = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'opencode-install.mjs')).href)) as { storeWriteTools: (root: string) => string[] };
  const expected = templateWriteTools();
  assert.ok(expected.length >= 29, `the template lists ${expected.length} store-write tools`);
  assert.deepEqual(readOnlyWriteTools(repoRoot), expected);
  assert.deepEqual(storeWriteTools(repoRoot), expected.map((t) => `sterling_${t}`));
  for (const write of ['knowledge_create', 'knowledge_update', 'board_add', 'config_set']) assert.ok(expected.includes(write), write);
  for (const read of ['knowledge_get', 'knowledge_query', 'board_query', 'knowledge_preflight']) assert.ok(!expected.includes(read), read);
});

test('read-only mode: every store-write tool refuses and writes nothing, reads work, and a server without the flag still writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-read-only-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const path = join(dir, '.sterling', 'sterling.db');
    const writeTools = readOnlyWriteTools(repoRoot);
    const ro = createSterlingServer(path, { readOnly: { writeTools } });
    assert.deepEqual(ro.toolWrappers, ['read_only', 'busy_refusal'], 'the read-only guard is installed first');
    const client = await connect(ro.server);
    try {
      const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
      for (const name of writeTools) {
        assert.ok(listed.has(name), `${name} is a tool of this server`);
        assert.match(listed.get(name)?.description ?? '', /^REFUSED on this server: /, `${name}: its description says it is refused`);
        // Valid-looking and junk arguments alike reach the refusal.
        for (const args of [{ type: 'decision', id: 'x', text: 'x', fields: {} }, {}]) {
          const r = (await client.callTool({ name, arguments: args })) as CallResult;
          assert.equal(r.isError, true, `${name} must refuse`);
          assert.match(r.content[0].text, new RegExp(`${name} writes the Sterling store, and this server runs with --read-only`), name);
        }
      }
      assert.deepEqual(ro.tools.boardQuery({}), [], 'no board write reached the store');
      assert.deepEqual(ro.tools.knowledgeQuery({} as never), [], 'no record write reached the store');
      for (const read of ['knowledge_query', 'board_query', 'knowledge_preflight']) {
        assert.ok(!listed.get(read)?.description?.startsWith('REFUSED'), read);
      }
      const query = (await client.callTool({ name: 'knowledge_query', arguments: { types: ['decision'] } })) as CallResult;
      assert.notEqual(query.isError, true, query.content[0]?.text);
      const board = (await client.callTool({ name: 'board_query', arguments: {} })) as CallResult;
      assert.notEqual(board.isError, true, board.content[0]?.text);
    } finally {
      await client.close();
      ro.store.close();
    }

    // The same store under a server started without --read-only accepts the write.
    const rw = createSterlingServer(path);
    assert.deepEqual(rw.toolWrappers, ['busy_refusal']);
    const rwClient = await connect(rw.server);
    try {
      const added = (await rwClient.callTool({ name: 'board_add', arguments: { text: 'a task', source: 'user' } })) as CallResult;
      assert.notEqual(added.isError, true, added.content[0]?.text);
      assert.equal(rw.tools.boardQuery({}).length, 1);
    } finally {
      await rwClient.close();
      rw.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only mode refuses boot on an empty list, an unreadable or empty template, and a listed name the server does not register', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-read-only-boot-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const path = join(dir, '.sterling', 'sterling.db');
    assert.throws(() => createSterlingServer(path, { readOnly: { writeTools: [] } }), /non-empty store-write tool list/);
    assert.throws(() => createSterlingServer(path, { readOnly: { writeTools: ['knowledge_create', 'knowledge_no_such_tool'] } }), /names knowledge_no_such_tool, which this server does not register/);

    assert.throws(() => readOnlyWriteTools(null), /no Sterling root/);
    const root = join(dir, 'root');
    assert.throws(() => readOnlyWriteTools(root), /could not be read .*ENOENT/);
    mkdirSync(join(root, 'agent-templates'), { recursive: true });
    writeFileSync(join(root, 'agent-templates', 'implementor.md'), '---\nname: implementor\ntools: Read\n---\nbody\n');
    assert.throws(() => readOnlyWriteTools(root), /names no mcp__sterling__ tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stdio entry: --read-only boots from this checkout and serves no write; a checkout without the template refuses boot with exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-read-only-main-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, '--store', join(dir, '.sterling', 'sterling.db'), '--read-only'], stderr: 'pipe' });
    const client = new Client({ name: 'read-only-main-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const r = (await client.callTool({ name: 'knowledge_create', arguments: { type: 'decision' } })) as CallResult;
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /knowledge_create writes the Sterling store, and this server runs with --read-only/);
      const read = (await client.callTool({ name: 'board_query', arguments: {} })) as CallResult;
      assert.notEqual(read.isError, true, read.content[0]?.text);
    } finally {
      await client.close();
    }

    // The bundled server in a Sterling root with no agent template, then with one naming no
    // store-write tool: each refuses boot with exit 2 and names the cause.
    const fake = join(dir, 'fake');
    mkdirSync(join(fake, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fake, '.claude-plugin', 'plugin.json'), '{}');
    const built = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build-mcp.mjs'), '--out-dir', join(fake, 'mcp')], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
    assert.equal(built.status, 0, built.stderr);
    const boot = () => spawnSync(process.execPath, [join(fake, 'mcp', 'sterling-mcp.mjs'), '--store', join(dir, '.sterling', 'sterling.db'), '--read-only'], { encoding: 'utf8', timeout: 20_000, input: '' });
    const missing = boot();
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /--read-only: the store-write tool list could not be read/);
    mkdirSync(join(fake, 'agent-templates'));
    writeFileSync(join(fake, 'agent-templates', 'implementor.md'), '---\nname: implementor\ntools: Read\n---\nbody\n');
    const empty = boot();
    assert.equal(empty.status, 2, empty.stderr);
    assert.match(empty.stderr, /names no mcp__sterling__ tool/);
    // A listed tool the server does not register is a refused boot too: exit 2, not 1.
    writeFileSync(join(fake, 'agent-templates', 'implementor.md'), '---\nname: implementor\ndisallowedTools: mcp__sterling__knowledge_create, mcp__sterling__knowledge_no_such_tool\n---\nbody\n');
    const unmatched = boot();
    assert.equal(unmatched.status, 2, unmatched.stderr);
    assert.match(unmatched.stderr, /ReadOnlyBootError: --read-only: the store-write tool list names knowledge_no_such_tool, which this server does not register/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--capabilities prints one JSON line naming read-only mode and exits 0 before opening anything, from the entry and from the bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-capabilities-'));
  try {
    const want = { sterling_mcp: { read_only: true } };
    for (const entry of [MAIN, join(repoRoot, 'mcp', 'sterling-mcp.mjs')]) {
      const r = spawnSync(process.execPath, [entry, '--capabilities'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `${entry}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), want, entry);
    }
    assert.deepEqual(readdirSync(dir), [], 'nothing was written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
