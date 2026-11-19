// config_set for an adopted custom agent (GitHub #312): models.custom-<slug> may omit model and
// effort, and what it does hold is validated strictly. Reads the real handler like config-set.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cs-custom-'));
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), '{}\n');
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: root, now: () => '2026-11-18T00:00:00.000Z' });
  return { root, store, set: (path: string, value: unknown) => (tools as unknown as { configSet(a: object): unknown }).configSet.call(tools, { path, value }) };
}
const read = (root: string) => JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8'));

test('config_set lands an empty custom entry and a partial one', () => {
  const { root, store, set } = setup();
  try {
    set('models.custom-team-scout', {});
    set('models.custom-helper.effort', 'high');
    assert.deepEqual(read(root).models, { 'custom-team-scout': {}, 'custom-helper': { effort: 'high' } });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('config_set refuses a bad value in a custom entry and a half entry under another key', () => {
  const { root, store, set } = setup();
  try {
    assert.throws(() => set('models.custom-x', { model: 'has space' }), /would fail schema validation/);
    assert.throws(() => set('models.custom-x', { effort: 'max' }), /would fail schema validation/);
    assert.throws(() => set('models.custom-x', { junk: 1 }), /would fail schema validation/);
    assert.throws(() => set('models.custom-x.agy_model', 'claude-opus-5-5-high'), /agy_model: must be one of/);
    // Changed with the cutover: effort is optional in the canonical shape (unset stays unset), so a half entry
    // under a non-custom key is half for lacking its MODEL.
    assert.throws(() => set('models.other-agent', { effort: 'low' }), /model/);
    assert.deepEqual(read(root), {});
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
