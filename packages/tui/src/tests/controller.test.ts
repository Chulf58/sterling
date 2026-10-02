import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDashboard, type DashboardController } from '../controller.js';
import { SYSTEM_TAB } from '../state.js';

// The dashboard controller is the host-neutral half of main.ts: the store and
// config code paths both the terminal TUI and the OpenCode plugin drive. These
// tests pin the write paths through it and the per-host effect switch.

const VP = { width: 100, maxBodyLines: 40, showBanner: false };

function fixture(config: Record<string, unknown> = { tdd: { enabled: true } }): { dir: string; storePath: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-controller-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { dir, storePath: join(dir, '.sterling', 'sterling.db'), configPath };
}

function addTodo(ctl: DashboardController, text: string): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  ctl.store.create({
    id, type: 'todo', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], source: 'user', text,
  } as never);
  return id;
}

test('controller: the TDD toggle on the System tab writes config.tdd.enabled through handle()', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.tdd?.enabled, true, 'the roster loads on System-tab activation');
    // config.models defaults fill the top rows; the mode row is last (DOWN
    // clamps on it) and the tdd row sits directly above it.
    for (let i = 0; i < 30; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    await ctl.handle({ kind: 'key', name: 'UP' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    const written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(written.tdd.enabled, false, 'config.tdd.enabled flipped on disk');
    assert.equal(ctl.roster()?.tdd?.enabled, false, 'the roster reloads after the write');
    assert.match(ctl.ui().notice ?? '', /config\.json updated/);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: activating a card writes the selection row by default', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    const id = addTodo(ctl, 'Selectable item');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.equal(ctl.store.takeSelection()?.record_id, id);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a disabled select effect is dropped and nothing reaches the selection row', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath, { disabledEffects: { select: null } });
  try {
    addTodo(ctl, 'Selectable item');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.equal(ctl.store.takeSelection(), undefined);
    assert.equal(ctl.ui().expanded.length, 1, 'the card still expands; only the handoff is off');
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a disabled model_swap surfaces its notice and leaves config.models untouched', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high' } } });
  const ctl = openDashboard(f.storePath, { disabledEffects: { model_swap: 'model swap is off here' } });
  try {
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-a', effort: 'high' }, to: { model: 'claude-b', effort: 'low' }, agents: [], decisionTitle: 't' },
    ]);
    assert.equal(ctl.ui().notice, 'model swap is off here');
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor.model, 'claude-a');
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a model swap also re-renders the Sterling-full OpenCode agents with the matching OpenCode model', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high' } } });
  const ocDir = join(f.dir, '.opencode', 'agents', 'sterling');
  mkdirSync(ocDir, { recursive: true });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-a', effort: 'high' }, to: { model: 'claude-b', effort: 'low' }, agents: ['implementor'], decisionTitle: 't' },
    ]);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor.model, 'claude-b');
    assert.match(readFileSync(join(ocDir, 'implementor.md'), 'utf8'), /^model: anthropic\/claude-b$/m);
    assert.doesNotMatch(readFileSync(join(ocDir, 'conductor.md'), 'utf8'), /^model:/m);
    assert.equal(ctl.ui().notice, undefined, ctl.ui().notice);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: an OpenCode re-render failure is folded into the notice; the swap decision is still recorded', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high' } } });
  // a directory where the implementor file belongs makes the re-render throw (EISDIR)
  mkdirSync(join(f.dir, '.opencode', 'agents', 'sterling', 'implementor.md'), { recursive: true });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-a', effort: 'high' }, to: { model: 'claude-b', effort: 'low' }, agents: ['implementor'], decisionTitle: 'swap-decision-title' },
    ]);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor.model, 'claude-b');
    assert.match(ctl.ui().notice ?? '', /OpenCode agent re-render failed/);
    const decisions = ctl.store.query({ types: ['decision'], cap: 10 }) as Array<{ title: string }>;
    assert.ok(decisions.some((d) => d.title === 'swap-decision-title'), 'the swap decision was written');
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a model swap in a project without OpenCode agents writes no .opencode files', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high' } } });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-a', effort: 'high' }, to: { model: 'claude-b', effort: 'low' }, agents: ['implementor'], decisionTitle: 't' },
    ]);
    assert.equal(existsSync(join(f.dir, '.opencode')), false);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: q on the Tasks tab reports quit', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    assert.equal(await ctl.handle({ kind: 'char', ch: 'q' }, VP), true);
    assert.equal(await ctl.handle({ kind: 'key', name: 'DOWN' }, VP), false);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: state() builds the dashboard with the project folder name', () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    const st = ctl.state(VP);
    assert.equal(st.tabs.length, 4);
    assert.ok(st.projectName.length > 0);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
