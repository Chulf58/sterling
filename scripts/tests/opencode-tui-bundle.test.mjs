// The shipped OpenCode dashboard plugin (opencode/sterling-tui) loads from the
// tracked files alone: a marketplace install has no node_modules and no
// packages/*/dist, so the entry package.json exports['./tui'] must name a
// committed bundle whose only imports are the ones OpenCode provides
// (solid-js, @opentui/solid) and node: built-ins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'sterling-oc-tui-bundle-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** Copy the tracked files under opencode/ (and nothing else) into a fresh tree. */
function trackedCopy() {
  const ls = spawnSync('git', ['ls-files', '-z', '--', 'opencode'], { cwd: repo, encoding: 'utf8' });
  assert.equal(ls.status, 0, ls.stderr);
  const root = join(work, 'archive');
  for (const rel of ls.stdout.split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(root, rel));
  }
  return root;
}

/** Minimal stand-ins for the two packages OpenCode supplies to a TUI plugin. */
function stubHostPackages(root) {
  const nm = join(root, 'node_modules');
  mkdirSync(join(nm, 'solid-js'), { recursive: true });
  writeFileSync(join(nm, 'solid-js', 'package.json'), JSON.stringify({ name: 'solid-js', type: 'module', exports: { '.': './index.js' } }));
  writeFileSync(join(nm, 'solid-js', 'index.js'), 'export const createSignal = (v) => [() => v, () => {}];\nexport const For = () => null;\nexport const Show = () => null;\n');
  mkdirSync(join(nm, '@opentui', 'solid'), { recursive: true });
  writeFileSync(join(nm, '@opentui', 'solid', 'package.json'), JSON.stringify({ name: '@opentui/solid', type: 'module', exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js' } }));
  writeFileSync(join(nm, '@opentui', 'solid', 'index.js'), 'export const useKeyboard = () => {};\nexport const useTerminalDimensions = () => () => ({ width: 80, height: 24 });\n');
  writeFileSync(join(nm, '@opentui', 'solid', 'jsx-runtime.js'), 'export const jsx = () => null;\nexport const jsxs = jsx;\nexport const Fragment = () => null;\n');
}

function fakeApi(directory) {
  const calls = { slots: 0, routes: 0 };
  const api = {
    location: { directory },
    keymap: { layer() {}, shortcuts: () => [], mode: { current: () => 'base' } },
    ui: {
      dialog: { clear() {} },
      router: { register: () => (calls.routes++, () => {}), navigate() {}, current: () => ({ type: 'home' }) },
      slot: () => (calls.slots++, () => {}),
    },
  };
  return { api, calls };
}

test('the shipped TUI entry is a committed bundle that imports only host-provided packages and node: built-ins', async () => {
  const root = trackedCopy();
  const pkgDir = join(root, 'opencode', 'sterling-tui');
  const entryRel = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).exports['./tui'];
  assert.notEqual(entryRel, './tui.tsx', 'the entry is the bundle, not the source');
  const code = readFileSync(join(pkgDir, entryRel), 'utf8');
  assert.match(code.split('\n')[0], /@jsxImportSource @opentui\/solid/, 'the JSX pragma OpenCode compiles with leads the file');
  const specifiers = [...code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.match(s, /^(node:|solid-js$|@opentui\/solid$)/, `unexpected import '${s}'`);

  // Load it as OpenCode would, minus the Solid compiler: JSX compiled by esbuild, host packages stubbed.
  stubHostPackages(root);
  const out = await transform(code, { loader: 'tsx', jsx: 'automatic', jsxImportSource: '@opentui/solid', format: 'esm' });
  const loadable = join(pkgDir, 'loadable.mjs');
  writeFileSync(loadable, out.code);
  const plugin = (await import(pathToFileURL(loadable).href)).default;
  assert.equal(plugin.id, 'sterling.dashboard');

  // Outside a Sterling project: a no-op, with no slot, command or route.
  const plain = fakeApi(mkdtempSync(join(work, 'plain-')));
  const disposePlain = plugin.setup(plain.api);
  assert.equal(typeof disposePlain, 'function');
  assert.deepEqual(plain.calls, { slots: 0, routes: 0 });

  // Inside one: the sidebar and command slots and the full-view route.
  const proj = mkdtempSync(join(work, 'proj-'));
  mkdirSync(join(proj, '.sterling'));
  writeFileSync(join(proj, '.sterling', 'sterling.db'), '');
  const sterling = fakeApi(proj);
  const dispose = plugin.setup(sterling.api);
  try {
    assert.deepEqual(sterling.calls, { slots: 2, routes: 1 });
  } finally {
    dispose();
  }
});
