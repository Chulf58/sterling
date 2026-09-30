// Plugin runtime bundles (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// slice S1): a /plugin install is a copy of the git tree with no build step,
// so mcp/ and bin/ must run with NO node_modules and NO packages/*/dist.
// Every build here goes to a TEMP dir outside the repo, never over the shipped
// bundles (board 3e569411), and every run happens from a temp dir that has no
// node_modules above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN_ENTRIES } from '../lib/bundled-artifacts.mjs';
import { checkAdapterRegistry } from '../adapters/resolve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function buildInto(script, outDir) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), '--out-dir', outDir], { encoding: 'utf8', cwd: root, timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
}

// Only node: builtins may be imported at run time — anything else would need a
// node_modules the installed copy does not have.
function nonBuiltinImports(src) {
  return [...src.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*"([^"]+)"|import\("([^"*]+)"\)/gm)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => !s.startsWith('node:'));
}

function initialize(serverFile, storePath, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverFile, '--store', storePath], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no initialize response within 30s; stderr: ${err}`));
    }, 30_000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.trim());
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolvePromise(JSON.parse(line));
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-bundles-test', version: '0' } } }) + '\n'
    );
  });
}

test('mcp bundle: answers initialize standalone and records the .build-id beside it as the runtime build', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sterling-mcp-bundle-'));
  try {
    buildInto('build-mcp.mjs', join(tmp, 'mcp'));
    assert.deepEqual(readdirSync(join(tmp, 'mcp')).sort(), ['.build-id', 'sterling-mcp.mjs']);
    const src = readFileSync(join(tmp, 'mcp', 'sterling-mcp.mjs'), 'utf8');
    assert.deepEqual(nonBuiltinImports(src), [], 'the server imports only node: builtins (node:sqlite stays external)');
    const buildId = readFileSync(join(tmp, 'mcp', '.build-id'), 'utf8');
    assert.match(buildId, /^[0-9a-f]{16}$/);

    const reply = await initialize(join(tmp, 'mcp', 'sterling-mcp.mjs'), join(tmp, 's.db'), tmp);
    assert.equal(reply.id, 1);
    assert.equal(reply.result?.serverInfo?.name, 'sterling', JSON.stringify(reply));

    const marker = JSON.parse(readFileSync(join(tmp, 'transient', 'mcp-runtime.json'), 'utf8'));
    assert.equal(marker.build_id, buildId, 'recordRuntimeMarker reads mcp/.build-id beside the running bundle');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bin bundles: one per BIN_ENTRIES member, node: imports only, source identities point at real shipped files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sterling-bin-bundle-'));
  try {
    const binDir = join(tmp, 'bin');
    buildInto('build-bin.mjs', binDir);
    assert.deepEqual(readdirSync(binDir).sort(), Object.keys(BIN_ENTRIES).map((n) => `${n}.mjs`).sort());
    for (const file of readdirSync(binDir)) {
      const src = readFileSync(join(binDir, file), 'utf8');
      assert.deepEqual(nonBuiltinImports(src), [], `${file} imports only node: builtins`);
      assert.ok(!src.includes(root), `${file} embeds no build-machine path`);
      // Every rewritten import.meta.url is relative to the SHIPPED bin/, so it
      // must name a file that exists in this tree (shipped beside bin/).
      for (const m of src.matchAll(/new URL\("(\.\.\/[^"]+)", import\.meta\.url\)/g)) {
        const target = resolve(root, 'bin', m[1]);
        assert.ok(existsSync(target), `${file}: source identity ${m[1]} names a file that does not exist`);
      }
    }
    // init reaches its adapters through a bundled glob import, not a runtime
    // import of scripts/adapters/*.mjs (node.mjs imports @sterling/schemas).
    const init = readFileSync(join(binDir, 'init.mjs'), 'utf8');
    // A nested module keeps its OWN location (resolve.mjs reads its sibling
    // registry.json), not the bundle's — without the rewrite it would read bin/registry.json.
    assert.ok(init.includes('new URL("../scripts/adapters/resolve.mjs", import.meta.url)'), 'scripts/adapters/resolve.mjs keeps its source identity');
    for (const adapter of ['node', 'pester', 'none']) assert.ok(init.includes(`"scripts/adapters/${adapter}.mjs"()`), `init bundles the ${adapter} adapter`);

    // Standalone run: no node_modules above tmp, registry relocated into tmp.
    const run = spawnSync(process.execPath, [join(binDir, 'list-projects.mjs')], {
      encoding: 'utf8',
      cwd: tmp,
      timeout: 60_000,
      env: { ...process.env, STERLING_REGISTRY_DB: join(tmp, 'registry.db') },
    });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('adapter registry: a module that is not a .mjs file is refused as unloadable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-adapter-registry-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, adapters: [{ name: 'odd', module: 'odd.js' }] }));
    const violations = await checkAdapterRegistry(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'module_unloadable');
    assert.match(violations[0].detail, /must be a \.mjs file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook bundle bytes do not depend on the cwd the build ran from (absWorkingDir pinned to the repo root)', () => {
  // esbuild writes module paths into the bundle relative to absWorkingDir,
  // which defaults to process.cwd(); unpinned, check-bundles-fresh run from
  // anywhere but the repo root reported every committed hook bundle stale.
  const hook = readdirSync(join(root, 'scripts', 'hooks')).find((f) => f.startsWith('h') && f.endsWith('.mjs'));
  const base = mkdtempSync(join(tmpdir(), 'sterling-hook-cwd-'));
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const lib = JSON.stringify(join(root, 'scripts', 'lib', 'bundled-artifacts.mjs'));
  try {
    const built = {};
    for (const [label, cwd] of [['root', root], ['elsewhere', elsewhere]]) {
      const outDir = join(base, `out-${label}`);
      const code = `const { buildHooks } = await import(${lib}); await buildHooks({ root: ${JSON.stringify(root)}, srcDir: ${JSON.stringify(join(root, 'scripts', 'hooks'))}, outDir: ${JSON.stringify(outDir)}, only: [${JSON.stringify(hook)}] });`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr);
      built[label] = readFileSync(join(outDir, hook), 'utf8');
    }
    assert.equal(built.elsewhere, built.root, `${hook} built from ${elsewhere} differs from the repo-root build`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
