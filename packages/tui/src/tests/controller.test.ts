import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, symlinkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDashboard, type DashboardController } from '../controller.js';
import { SYSTEM_TAB, modelChoices } from '../state.js';

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
    // config.models defaults fill the top rows. This fixture is in hobby mode, where the PR auto-merge row is
    // disabled (2026-11-18, System tab redesign item 2), so the handoff files row is the last stop (DOWN clamps
    // on it), the mode row sits above it and the tdd row above that.
    for (let i = 0; i < 30; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    await ctl.handle({ kind: 'key', name: 'UP' }, VP);
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

// The handoff files row writes only config.handoff.enabled (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting); the Project mode
// row is gone (decision system-tab-layout-one-screen-with-three-sections-agents-one).
test('controller: the handoff toggle writes config.handoff.enabled and leaves the workflow alone', async () => {
  const f = fixture({ workflow: { merge: 'pr', reviewers: 2, copilot_loop: true, auto_merge_on_clean: true }, tdd: { enabled: true } });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.handoff, false, 'no handoff key and nothing tracked reads off');
    // the handoff files row is the last cursor stop of the tab (storage below it is read-only)
    for (let i = 0; i < 40; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    let written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.deepEqual(written.handoff, { enabled: true }, 'config.handoff.enabled written');
    assert.deepEqual(written.workflow, { merge: 'pr', reviewers: 2, copilot_loop: true, auto_merge_on_clean: true }, 'the workflow is untouched');
    assert.equal(ctl.roster()?.handoff, true, 'the roster reloads after the write');
    assert.match(ctl.ui().notice ?? '', /^handoff files turned on — run \/sterling:update \(or init\)/);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.deepEqual(written.handoff, { enabled: false });
    assert.match(ctl.ui().notice ?? '', /^handoff files turned off — .*NOT deleted/);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a non-boolean handoff value reaches the roster as its JSON text (the row shows INVALID)', async () => {
  const f = fixture({ handoff: { enabled: 'yes' } });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.handoff, '"yes"');
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

test('controller: q on the Tasks tab reports quit', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    // q asks first (board fb516a43); the second q reports the quit
    assert.equal(await ctl.handle({ kind: 'char', ch: 'q' }, VP), false);
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

test('controller: the handoff row says why — not set for an absent key, the tracked-files note, and UNKNOWN with the git error when git cannot answer', async () => {
  const f = fixture({ mode: 'work' });
  const git = (args: string[]) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: f.dir, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  const load = async () => {
    const ctl = openDashboard(f.storePath);
    try {
      await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
      return { handoff: ctl.roster()?.handoff, detail: ctl.roster()?.handoffDetail };
    } finally {
      ctl.close();
    }
  };
  try {
    assert.deepEqual(await load(), { handoff: false, detail: 'not set' });
    git(['init', '-q']);
    mkdirSync(join(f.dir, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(f.dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
    git(['add', '.opencode/agents/scout.md']);
    git(['commit', '-qm', 'portable']);
    assert.deepEqual(await load(), { handoff: true, detail: 'not set; handoff files are tracked in git' });
    writeFileSync(join(f.dir, '.git', 'index'), 'not an index');
    const unknown = await load();
    assert.equal(unknown.handoff, null, 'never the off default');
    assert.match(unknown.detail ?? '', /^git ls-files exited 128: /);
    writeFileSync(f.configPath, JSON.stringify({ mode: 'work', handoff: { enabled: false } }));
    assert.deepEqual(await load(), { handoff: false, detail: undefined }, 'an explicit key never asks git and carries no note');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// decision opencode-only-model-override-per-role-for-openai-picks

test('controller: a fresh dashboard seeds the models catalog with vendor and id split, so the picker never shows anthropic/anthropic/... or a logical overpass/ or agy/ id as a catalog model (item-G review finding 6)', async () => {
  const f = fixture({ tdd: { enabled: true }, models: { implementor: { model: 'openai/gpt-5.6-terra', effort: 'high' }, scout: { model: 'overpass/agentic-auto' }, librarian: { model: 'agy/flash' } } });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    const snap = ctl.roster();
    assert.ok(snap?.catalog.present, 'the catalog was seeded');
    const ids = snap!.catalog.entries.map((e) => `${e.vendor ?? 'anthropic'}/${e.id}`);
    assert.ok(ids.includes('anthropic/claude-opus-5-5'), ids.join(', '));
    assert.ok(ids.includes('openai/gpt-5.6-terra'), ids.join(', '));
    assert.deepEqual(snap!.catalog.entries.filter((e) => e.id.includes('/')), [], 'no catalog id carries a provider prefix');
    const refs = modelChoices(snap!, 'implementor').flatMap((o) => ('ref' in o.choice ? [o.choice.ref] : []));
    assert.deepEqual(refs.filter((r) => /^anthropic\/anthropic\/|^[^/]+\/(overpass|agy|openai|anthropic)\//.test(r)), [], refs.join(', '));
    assert.equal(refs.filter((r) => r === 'overpass/agentic-auto').length, 1, 'a tier is offered once, as itself');
    assert.equal(refs.filter((r) => r === 'agy/flash').length, 1);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
