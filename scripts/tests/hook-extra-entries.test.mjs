// Extra hook-directory entries (board postgres-slice-3c, issue 26 item 3): a
// file that is not an h*.mjs hook but has to ship BESIDE the hook bundles, the
// Postgres worker being the first. The store spawns it with
// `new Worker(new URL('./pg-worker.js', import.meta.url))`, and import.meta.url
// in a hook bundle is the bundle's own URL, so the worker must sit in hooks/.
// buildHooks emits every member of the ONE declared list HOOK_EXTRA_ENTRIES,
// and the freshness check compares whatever a build emits, so the worker is
// freshness-gated the moment it is declared.
//
// Every build here goes to a temp dir, never over the shipped hooks/ (anti_pattern
// a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree). The fixture
// entry imports node-postgres for real, so the createRequire banner is exercised:
// without it the bundle fails at load with 'Dynamic require of "events"'. Nothing
// here connects to a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_ARTIFACTS, HOOK_EXTRA_ENTRIES, buildHooks, staleAgainstShipped } from '../lib/bundled-artifacts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A tiny hook source dir plus a pg-importing worker source, both in a temp dir.
function fixtureTree() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-hook-extra-'));
  const srcDir = join(base, 'src');
  mkdirSync(srcDir);
  writeFileSync(join(srcDir, 'h0-fixture.mjs'), "process.stdout.write('hook ran\\n');\n");
  const workerSrc = join(base, 'worker-src.mjs');
  writeFileSync(workerSrc, "import pg from 'pg';\nprocess.stdout.write(`pg.Client is a ${typeof pg.Client}\\n`);\n");
  return { base, srcDir, workerSrc, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('a declared extra entry is emitted beside the hook bundles and listed in the build manifest', async () => {
  const t = fixtureTree();
  try {
    const outDir = join(t.base, 'out');
    const emitted = await buildHooks({ root, srcDir: t.srcDir, outDir, extraEntries: [{ source: t.workerSrc, out: 'pg-worker.js' }] });
    assert.deepEqual(emitted.sort(), [join(outDir, 'h0-fixture.mjs'), join(outDir, 'pg-worker.js')].sort());
    assert.deepEqual(readdirSync(outDir).sort(), ['h0-fixture.mjs', 'pg-worker.js']);
  } finally {
    t.cleanup();
  }
});

test('the extra entry loads node-postgres standalone: banner applied, no node_modules, package type module', async () => {
  const t = fixtureTree();
  try {
    // An installed plugin copy has the root package.json ("type": "module") and no
    // node_modules, so a .js bundle there is ESM and has no ambient require.
    const plugin = join(t.base, 'plugin');
    const outDir = join(plugin, 'hooks');
    await buildHooks({ root, srcDir: t.srcDir, outDir, extraEntries: [{ source: t.workerSrc, out: 'pg-worker.js' }] });
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'package.json'), '{"type":"module"}\n');
    const r = spawnSync(process.execPath, [join(outDir, 'pg-worker.js')], { cwd: plugin, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pg.Client is a function\n');
    assert.match(readFileSync(join(outDir, 'pg-worker.js'), 'utf8'), /createRequire as __cr/, 'the extra entry carries the createRequire banner');
  } finally {
    t.cleanup();
  }
});

test('hook entries do not get the banner: the bundle of an h*.mjs hook is unchanged by an extra entry', async () => {
  const t = fixtureTree();
  try {
    const plainOut = join(t.base, 'plain');
    const withOut = join(t.base, 'with');
    await buildHooks({ root, srcDir: t.srcDir, outDir: plainOut, extraEntries: [] });
    await buildHooks({ root, srcDir: t.srcDir, outDir: withOut, extraEntries: [{ source: t.workerSrc, out: 'pg-worker.js' }] });
    const hook = readFileSync(join(withOut, 'h0-fixture.mjs'), 'utf8');
    assert.equal(hook, readFileSync(join(plainOut, 'h0-fixture.mjs'), 'utf8'));
    assert.doesNotMatch(hook, /createRequire/);
  } finally {
    t.cleanup();
  }
});

test('an `only` build emits exactly the named hooks and no extra entries (the seam harness expects one bundle)', async () => {
  const t = fixtureTree();
  try {
    const outDir = join(t.base, 'out');
    const emitted = await buildHooks({ root, srcDir: t.srcDir, outDir, only: ['h0-fixture.mjs'], extraEntries: [{ source: t.workerSrc, out: 'pg-worker.js' }] });
    assert.deepEqual(emitted, [join(outDir, 'h0-fixture.mjs')]);
    assert.equal(existsSync(join(outDir, 'pg-worker.js')), false);
  } finally {
    t.cleanup();
  }
});

test('an extra entry whose output name collides with a hook, is a hook name, or leaves the directory is refused', async () => {
  const t = fixtureTree();
  try {
    const outDir = join(t.base, 'out');
    for (const out of ['h0-fixture.mjs', 'h9-other.mjs', '../pg-worker.js', 'sub/pg-worker.js', '']) {
      await assert.rejects(buildHooks({ root, srcDir: t.srcDir, outDir, extraEntries: [{ source: t.workerSrc, out }] }), /buildHooks: extra entry/, `out '${out}'`);
    }
    await assert.rejects(
      buildHooks({ root, srcDir: t.srcDir, outDir, extraEntries: [{ source: t.workerSrc, out: 'a.js' }, { source: t.workerSrc, out: 'a.js' }] }),
      /buildHooks: extra entry/,
      'a duplicate output name'
    );
    assert.equal(existsSync(outDir), false, 'a refused list emits nothing');
  } finally {
    t.cleanup();
  }
});

test('an extra entry whose source does not exist fails the build loudly', async () => {
  const t = fixtureTree();
  try {
    await assert.rejects(buildHooks({ root, srcDir: t.srcDir, outDir: join(t.base, 'out'), extraEntries: [{ source: join(t.base, 'missing.js'), out: 'pg-worker.js' }] }));
  } finally {
    t.cleanup();
  }
});

test('freshness covers the extra entry: missing or changed beside the shipped hooks is stale, identical is fresh', async () => {
  const t = fixtureTree();
  try {
    const artifact = {
      name: 'hooks-fixture',
      kind: 'dir',
      shipped: 'hooks',
      build: ({ root: r, outTarget }) => buildHooks({ root: r, srcDir: t.srcDir, outDir: outTarget, extraEntries: [{ source: t.workerSrc, out: 'pg-worker.js' }] }),
    };
    const shippedRoot = join(t.base, 'shipped');
    await artifact.build({ root, outTarget: join(shippedRoot, 'hooks') });

    const fresh = await staleAgainstShipped({ artifact, root, shippedRoot });
    assert.deepEqual(fresh, { count: 2, stale: [] });

    rmSync(join(shippedRoot, 'hooks', 'pg-worker.js'));
    const missing = await staleAgainstShipped({ artifact, root, shippedRoot });
    assert.deepEqual(missing.stale, ['hooks/pg-worker.js (no shipped file)']);

    await artifact.build({ root, outTarget: join(shippedRoot, 'hooks') });
    writeFileSync(t.workerSrc, "import pg from 'pg';\nprocess.stdout.write(String(typeof pg.Pool));\n");
    const changed = await staleAgainstShipped({ artifact, root, shippedRoot });
    assert.deepEqual(changed.stale, ['hooks/pg-worker.js']);
  } finally {
    t.cleanup();
  }
});

test('freshness reports a failing or empty build as unverifiable, never as fresh', async () => {
  const failing = { name: 'boom', kind: 'dir', shipped: 'hooks', build: async () => { throw new Error('no entry'); } };
  assert.deepEqual(await staleAgainstShipped({ artifact: failing, root, shippedRoot: root }), { unverifiable: "building artifact 'boom' failed — no entry" });
  const empty = { name: 'void', kind: 'dir', shipped: 'hooks', build: async () => [] };
  assert.match((await staleAgainstShipped({ artifact: empty, root, shippedRoot: root })).unverifiable, /artifact 'void' emitted NOTHING/);
});

test('the registered hooks artifact builds the declared HOOK_EXTRA_ENTRIES list, not a copy of it', async () => {
  // The checker iterates BUNDLED_ARTIFACTS; this proves its hooks descriptor
  // reads the one declared list, so a member added there is freshness-gated.
  const t = fixtureTree();
  const hooks = BUNDLED_ARTIFACTS.find((a) => a.name === 'hooks');
  const marker = { source: t.workerSrc, out: 'fixture-extra.js' };
  HOOK_EXTRA_ENTRIES.push(marker);
  try {
    const outDir = join(t.base, 'out');
    const emitted = await hooks.build({ root, outTarget: outDir });
    assert.ok(emitted.includes(join(outDir, 'fixture-extra.js')), 'the hooks descriptor emitted the declared extra entry');
  } finally {
    HOOK_EXTRA_ENTRIES.splice(HOOK_EXTRA_ENTRIES.indexOf(marker), 1);
    t.cleanup();
  }
});

test('every declared extra entry names a source that exists (a missing worker fails here, not only in the build)', () => {
  for (const e of HOOK_EXTRA_ENTRIES) {
    assert.ok(existsSync(join(root, e.source)), `${e.source} does not exist — run npm run build`);
  }
});
