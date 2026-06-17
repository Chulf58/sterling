import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../registry.js';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-registry-'));
  const reg = new ProjectRegistry(join(dir, 'registry.db'));
  return { dir, reg, cleanup: () => { reg.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const base = (over = {}) => ({
  repo_path: 'C:/Users/x/ProjA',
  name: 'ProjA',
  stack_tags: ['node', 'typescript'],
  toolchains: ['node'],
  sterling_version: '0.1.0',
  at: '2026-06-17T10:00:00.000Z',
  ...over,
});

test('register: creates a row keyed by repo_path; first_init_at == last_init_at on first init; list parses arrays (decision 8f9e6db2)', () => {
  const { reg, cleanup } = harness();
  try {
    reg.register(base());
    const rows = reg.list();
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.repo_path, 'C:/Users/x/ProjA');
    assert.equal(r.name, 'ProjA');
    assert.deepEqual(r.stack_tags, ['node', 'typescript']);
    assert.deepEqual(r.toolchains, ['node']);
    assert.equal(r.sterling_version, '0.1.0');
    assert.equal(r.first_init_at, '2026-06-17T10:00:00.000Z');
    assert.equal(r.last_init_at, '2026-06-17T10:00:00.000Z');
    assert.equal(r.last_seen_at, null);
  } finally {
    cleanup();
  }
});

test('register upsert: re-init refreshes mutable fields + last_init_at but preserves first_init_at and last_seen_at', () => {
  const { reg, cleanup } = harness();
  try {
    reg.register(base());
    reg.touchLastSeen('C:/Users/x/ProjA', '2026-06-17T11:00:00.000Z');
    // re-init later, with changed stack/toolchains/version
    reg.register(base({ name: 'ProjA-renamed', stack_tags: ['node', 'genesys'], toolchains: ['node', 'pester'], sterling_version: '0.2.0', at: '2026-06-18T09:00:00.000Z' }));
    const rows = reg.list();
    assert.equal(rows.length, 1, 'upsert by repo_path — still one row');
    const r = rows[0];
    assert.equal(r.name, 'ProjA-renamed');
    assert.deepEqual(r.stack_tags, ['node', 'genesys']);
    assert.deepEqual(r.toolchains, ['node', 'pester']);
    assert.equal(r.sterling_version, '0.2.0');
    assert.equal(r.first_init_at, '2026-06-17T10:00:00.000Z', 'first_init_at preserved across re-init');
    assert.equal(r.last_init_at, '2026-06-18T09:00:00.000Z', 'last_init_at refreshed');
    assert.equal(r.last_seen_at, '2026-06-17T11:00:00.000Z', 'last_seen_at preserved across re-init (upsert does not reset it)');
  } finally {
    cleanup();
  }
});

test('touchLastSeen: updates an existing row, NEVER creates (registration is the init job)', () => {
  const { reg, cleanup } = harness();
  try {
    // unknown project → no create, returns false
    assert.equal(reg.touchLastSeen('C:/Users/x/Unknown', '2026-06-17T12:00:00.000Z'), false);
    assert.equal(reg.list().length, 0, 'touch on an unregistered project creates nothing');
    // registered project → updates, returns true
    reg.register(base());
    assert.equal(reg.touchLastSeen('C:/Users/x/ProjA', '2026-06-17T12:00:00.000Z'), true);
    assert.equal(reg.list()[0].last_seen_at, '2026-06-17T12:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('list spans multiple projects name-ordered; remove is by repo_path (human-gated prune)', () => {
  const { reg, cleanup } = harness();
  try {
    reg.register(base({ repo_path: 'C:/p/zeta', name: 'zeta' }));
    reg.register(base({ repo_path: 'C:/p/alpha', name: 'alpha' }));
    assert.deepEqual(reg.list().map((r) => r.name), ['alpha', 'zeta'], 'name-ordered');
    assert.equal(reg.remove('C:/p/alpha'), true);
    assert.equal(reg.remove('C:/p/alpha'), false, 'removing an absent project is a no-op false');
    assert.deepEqual(reg.list().map((r) => r.name), ['zeta']);
  } finally {
    cleanup();
  }
});
