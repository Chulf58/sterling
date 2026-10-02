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
import { ProjectRegistry, SterlingStore } from '@sterling/store';

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
    // plus the stamp-contract bullet history an installed copy reads in place of git (buildBins)
    assert.deepEqual(readdirSync(binDir).sort(), [...Object.keys(BIN_ENTRIES).map((n) => `${n}.mjs`), 'contract-history.json'].sort());
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

test('bin/ bundles the scripts an installed copy spawns: the consumer checks and the concept_designed fallback', () => {
  // templates/check-consumer.mjs spawns check-record-citations and check-stale-claims,
  // and templates/target-claude-md.md names concept-designed as the no-server fallback;
  // (and the MCP server names no-capture beside it as the no-server fallback);
  // each imports @sterling/* through scripts/lib/project.mjs, which an installed copy
  // (no node_modules) cannot resolve from the scripts/ source.
  for (const name of ['check-record-citations', 'check-stale-claims', 'concept-designed', 'no-capture']) {
    assert.ok(name in BIN_ENTRIES, `${name} is a BIN_ENTRIES member`);
    assert.ok(existsSync(join(root, 'bin', `${name}.mjs`)), `bin/${name}.mjs is committed`);
  }
  const claudeTemplate = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
  assert.ok(claudeTemplate.includes('${CLAUDE_PLUGIN_ROOT}/bin/concept-designed.mjs'), 'the template names the bundled fallback');
  assert.ok(!claudeTemplate.includes('${CLAUDE_PLUGIN_ROOT}/scripts/concept-designed.mjs'), 'and no longer the source that needs node_modules');
});

test('bin/concept-designed.mjs runs standalone from a tree with no node_modules', () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-bin-concept-'));
  try {
    mkdirSync(join(base, 'plugin', 'bin'), { recursive: true });
    const bundle = join(base, 'plugin', 'bin', 'concept-designed.mjs');
    writeFileSync(bundle, readFileSync(join(root, 'bin', 'concept-designed.mjs')));
    const project = join(base, 'project');
    mkdirSync(join(project, '.sterling'), { recursive: true });
    const r = spawnSync(process.execPath, [bundle, '--family', 'weapons', '--target', project], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('bin/migrate-stores.mjs --all-stores respawns ITSELF, not the scripts/ source it was bundled from', () => {
  // The source-identity rewrite makes the bundle's import.meta.url name
  // scripts/migrate-stores.mjs; respawning that path on an installed copy runs a
  // source that needs @sterling/store. The bundle is copied alone into a tree with
  // no scripts/ and no node_modules, so only a self-respawn of the bundle can work.
  const base = mkdtempSync(join(tmpdir(), 'sterling-bin-migrate-'));
  try {
    mkdirSync(join(base, 'plugin', 'bin'), { recursive: true });
    const bundle = join(base, 'plugin', 'bin', 'migrate-stores.mjs');
    writeFileSync(bundle, readFileSync(join(root, 'bin', 'migrate-stores.mjs')));
    const domainsRoot = join(base, 'domains');
    const db = join(domainsRoot, 'alpha', 'sterling.db');
    mkdirSync(dirname(db), { recursive: true });
    new SterlingStore(db).close();
    const registryDb = join(base, 'registry.db');
    new ProjectRegistry(registryDb).close();
    const r = spawnSync(process.execPath, [bundle, '--all-stores', '--roots', domainsRoot], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, STERLING_REGISTRY_DB: registryDb, HOME: join(base, 'home') },
    });
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const line = lines.find((l) => l.store === db);
    assert.ok(line, `the domain store is reported: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(JSON.stringify(line), /ERR_MODULE_NOT_FOUND|Cannot find/, 'the per-store child loaded');
    assert.equal(line.ok, true, JSON.stringify(line));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('bin/stamp-contract.mjs from a .git-less plugin root (an installed copy): never a crash — exit 0 or 2 and one line naming the missing history', () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-bin-stamp-'));
  try {
    const plugin = join(base, 'plugin');
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    mkdirSync(join(plugin, 'templates'), { recursive: true });
    writeFileSync(join(plugin, 'bin', 'stamp-contract.mjs'), readFileSync(join(root, 'bin', 'stamp-contract.mjs')));
    for (const t of ['target-agents-md.md', 'target-claude-md.md']) writeFileSync(join(plugin, 'templates', t), readFileSync(join(root, 'templates', t)));
    const registryDb = join(base, 'registry.db');
    new ProjectRegistry(registryDb).close();
    const r = spawnSync(process.execPath, [join(plugin, 'bin', 'stamp-contract.mjs'), '--project', join(base, 'project')], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: base,
      env: { ...process.env, STERLING_REGISTRY_DB: registryDb, GIT_CEILING_DIRECTORIES: base },
    });
    assert.ok(r.status === 0 || r.status === 2, `exit 0 or 2, never a crash: ${r.status}\n${r.stdout}${r.stderr}`);
    // no bin/contract-history.json was copied, so this is the degraded current-only path
    assert.ok(r.stderr.includes(`stamp-contract: DEGRADED — no git history at ${plugin} (installed plugin copy) and ${join(plugin, 'bin', 'contract-history.json')} is missing — only the current template text counts as template-descended; older bullets read as drift`), r.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
