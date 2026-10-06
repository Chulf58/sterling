// The Postgres worker beside EVERY bundle family that contains the store (board
// 6be7b53f, slice 3D; conductor ruling 2026-10-06: one rule for all families).
// pg-bridge spawns `new Worker(new URL('./pg-worker.js', import.meta.url))`.
// hooks/, mcp/ and opencode/ leave import.meta.url as the bundle's own URL; bin/,
// tui/ and opencode/sterling-tui/ rewrite it to each module's source location
// (sourceIdentityPlugin), which would send the worker URL into
// packages/store/dist/ — a directory an installed copy does not have. The plugin
// therefore keeps a declared beside-bundle name resolving against the bundle.
//
// Every build here goes to a temp dir, never over a shipped family (anti_pattern
// a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree). The handshake
// probe points the worker at 127.0.0.1:1, where nothing listens: an
// ECONNREFUSED reply proves the worker file was found, loaded node-postgres and
// ran its init handshake. No database is contacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BUNDLED_ARTIFACTS, EXTRA_ENTRIES, sourceIdentityPlugin, staleAgainstShipped } from '../lib/bundled-artifacts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HANDSHAKE = `
import { Worker, MessageChannel } from 'node:worker_threads';
const w = new Worker(process.argv[1], { execArgv: [] }); // not this probe's --input-type
const { port1, port2 } = new MessageChannel();
const control = new SharedArrayBuffer(4);
w.postMessage({ control, port: port2, config: { host: '127.0.0.1', port: 1, user: 'probe', password: 'probe', database: 'probe', connectionTimeoutMillis: 2000 } }, [port2]);
port1.once('message', (m) => { process.stdout.write(JSON.stringify(m)); process.exit(0); });
w.once('error', (e) => { process.stdout.write('worker error: ' + e.message); process.exit(1); });
setTimeout(() => { process.stdout.write('no handshake reply within 10s'); process.exit(1); }, 10000);
`;
function workerHandshake(workerPath, cwd) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', HANDSHAKE, workerPath], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ── every registered family, built once into temp dirs ──────────────────────
let base;
const built = new Map(); // family name -> { outDir, emitted }
before(async () => {
  base = mkdtempSync(join(tmpdir(), 'sterling-worker-families-'));
  for (const artifact of BUNDLED_ARTIFACTS) {
    const famDir = join(base, artifact.name);
    mkdirSync(famDir);
    const outTarget = artifact.kind === 'dir' ? famDir : join(famDir, basename(artifact.shipped));
    const emitted = await artifact.build({ root, outTarget });
    built.set(artifact.name, { outDir: famDir, emitted });
  }
});
after(() => rmSync(base, { recursive: true, force: true }));

test('every bundle family declares the pg worker as an extra entry', () => {
  for (const artifact of BUNDLED_ARTIFACTS) {
    const outs = (EXTRA_ENTRIES[artifact.name] ?? []).map((e) => e.out);
    assert.ok(outs.includes('pg-worker.js'), `${artifact.name} declares pg-worker.js`);
  }
});

test('every family emits pg-worker.js beside its bundles, and the build manifest lists it', () => {
  for (const [name, { outDir, emitted }] of built) {
    const worker = join(outDir, 'pg-worker.js');
    assert.ok(emitted.includes(worker), `${name}: the manifest lists ${worker}`);
    assert.ok(existsSync(worker), `${name}: pg-worker.js was written`);
  }
});

test('no bundle resolves the worker URL into the source tree', () => {
  for (const [name, { emitted }] of built) {
    for (const file of emitted) {
      if (!/\.(mjs|js|tsx)$/.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      assert.doesNotMatch(src, /new URL\(\s*["']\.\/pg-worker\.js["']\s*,\s*new URL\(/, `${name}: ${basename(file)} sends the worker URL through a source-identity URL`);
    }
  }
});

test('a bundle that carries the bridge resolves ./pg-worker.js against its own URL', () => {
  // bin/init and bin/update bundle the bridge today (measured 2026-10-06); at
  // least one bundle across the families must, or this pin proves nothing.
  let carriers = 0;
  for (const [, { emitted }] of built) {
    for (const file of emitted) {
      if (!/\.(mjs|js|tsx)$/.test(file) || basename(file) === 'pg-worker.js') continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('pg-worker.js')) continue;
      carriers++;
      assert.match(src, /new URL\(\s*["']\.\/pg-worker\.js["']\s*,\s*import\.meta\.url\s*\)/, `${basename(file)} keeps the bundle-relative worker URL`);
    }
  }
  assert.ok(carriers > 0, 'no built bundle carries the bridge, so the URL pin is vacuous');
});

test('the worker emitted for every family loads and reaches its connect handshake', () => {
  for (const [name, { outDir }] of built) {
    const r = workerHandshake(join(outDir, 'pg-worker.js'), outDir);
    assert.equal(r.code, 0, `${name}: ${r.out}`);
    assert.match(r.out, /"ok":false/, `${name}: ${r.out}`);
    assert.match(r.out, /ECONNREFUSED/, `${name}: ${r.out}`);
  }
});

// ── sourceIdentityPlugin: the beside-bundle exemption ───────────────────────
function pluginFixture(source) {
  const fx = mkdtempSync(join(tmpdir(), 'sterling-source-identity-'));
  mkdirSync(join(fx, 'src'));
  writeFileSync(join(fx, 'src', 'mod.mjs'), source);
  return fx;
}
const pluginBuild = (fx) =>
  build({
    entryPoints: [join(fx, 'src', 'mod.mjs')],
    outfile: join(fx, 'bin', 'mod.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    absWorkingDir: fx,
    logLevel: 'silent',
    plugins: [sourceIdentityPlugin({ root: fx, shippedDir: 'bin', besideBundle: ['pg-worker.js'] })],
  });

test('sourceIdentityPlugin keeps a beside-bundle URL on the bundle and still rewrites every other import.meta.url', async () => {
  const fx = pluginFixture(
    "process.stdout.write(new URL('./pg-worker.js', import.meta.url).href + '\\n');\n" +
      "process.stdout.write(new URL('./registry.json', import.meta.url).href + '\\n');\n" +
      'process.stdout.write(import.meta.url + "\\n");\n'
  );
  try {
    await pluginBuild(fx);
    const r = spawnSync(process.execPath, [join(fx, 'bin', 'mod.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      pathToFileURL(join(fx, 'bin', 'pg-worker.js')).href,
      pathToFileURL(join(fx, 'src', 'registry.json')).href,
      pathToFileURL(join(fx, 'src', 'mod.mjs')).href,
    ]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

test('sourceIdentityPlugin refuses a beside-bundle name it cannot recognise, rather than shipping a URL into the source tree', async () => {
  const fx = pluginFixture("const here = import.meta.url;\nprocess.stdout.write(new URL('./pg-worker.js', here).href);\n");
  try {
    await assert.rejects(pluginBuild(fx), /pg-worker\.js/);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

// ── freshness covers the worker of a single-file family ─────────────────────
test('freshness maps a single-file family\'s extra entry beside its shipped file', async () => {
  const fx = mkdtempSync(join(tmpdir(), 'sterling-file-family-'));
  try {
    const artifact = {
      name: 'fam',
      kind: 'file',
      shipped: 'fam/sub/main.mjs',
      build: async ({ outTarget }) => {
        mkdirSync(dirname(outTarget), { recursive: true });
        writeFileSync(outTarget, 'main');
        writeFileSync(join(dirname(outTarget), 'pg-worker.js'), 'worker');
        return [outTarget, join(dirname(outTarget), 'pg-worker.js')];
      },
    };
    const shippedRoot = join(fx, 'shipped');
    mkdirSync(join(shippedRoot, 'fam', 'sub'), { recursive: true });
    writeFileSync(join(shippedRoot, 'fam', 'sub', 'main.mjs'), 'main');
    assert.deepEqual(await staleAgainstShipped({ artifact, root, shippedRoot }), { count: 2, stale: ['fam/sub/pg-worker.js (no shipped file)'] });
    writeFileSync(join(shippedRoot, 'fam', 'sub', 'pg-worker.js'), 'worker');
    assert.deepEqual(await staleAgainstShipped({ artifact, root, shippedRoot }), { count: 2, stale: [] });
    writeFileSync(join(shippedRoot, 'fam', 'sub', 'pg-worker.js'), 'older worker');
    assert.deepEqual((await staleAgainstShipped({ artifact, root, shippedRoot })).stale, ['fam/sub/pg-worker.js']);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});
