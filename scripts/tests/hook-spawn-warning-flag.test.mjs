// Gap 7 (board ks-dashboards-gap-7): a test that spawns a hook and asserts an empty or
// exact stderr must run node with the flag hooks/hooks.json passes in production. Local
// Node may not print the node:sqlite ExperimentalWarning (24.21 does not; 24.14 does), so
// the flag is proved on a script that emits that warning itself, and the spawning test
// is pinned to the shared constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_NODE_FLAGS } from './lib/node-quiet.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WARN = "process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');";

const run = (flags) => spawnSync(process.execPath, [...flags, '-e', WARN], { encoding: 'utf8', timeout: 30_000 });

test('control: without the flag a script that emits an ExperimentalWarning writes it to stderr', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ExperimentalWarning/);
});

test('HOOK_NODE_FLAGS silences the ExperimentalWarning, so an empty-stderr assertion holds on any Node', () => {
  const r = run(HOOK_NODE_FLAGS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('HOOK_NODE_FLAGS is the exact flag hooks/hooks.json passes in production', () => {
  const hooks = readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8');
  for (const flag of HOOK_NODE_FLAGS) assert.ok(hooks.includes(`node ${flag} `), `hooks.json passes ${flag}`);
});

test('dispatch-state-hooks.test.mjs spawns every hook through HOOK_NODE_FLAGS', () => {
  const src = readFileSync(join(root, 'scripts', 'tests', 'dispatch-state-hooks.test.mjs'), 'utf8');
  const spawns = src.match(/spawnSync\(process\.execPath, \[[^\]]*\]/g) ?? [];
  assert.ok(spawns.length >= 2, `found the hook spawn sites (${spawns.length})`);
  for (const s of spawns) assert.ok(s.includes('...HOOK_NODE_FLAGS'), `${s} passes the production flags`);
});
