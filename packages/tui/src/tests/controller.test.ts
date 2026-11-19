import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, symlinkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDashboard, type DashboardController } from '../controller.js';
import { SYSTEM_TAB, modelChoices, systemCursorOf } from '../state.js';
import { applyHandoffToggle } from '../config-writeback.js';

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

// Restored from the pre-cutover suite (model_swap), ported to the agent_model effect that replaced it.
test('controller: a disabled agent_model effect surfaces its notice and leaves config.models untouched', async () => {
  const f = fixture({ models: { implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } } });
  const before = readFileSync(f.configPath, 'utf8');
  const ctl = openDashboard(f.storePath, { disabledEffects: { agent_model: 'model change is off here' } });
  try {
    await ctl.applyEffects([{ type: 'agent_model', key: 'implementor', model: 'anthropic/claude-opus-5-5', effort: 'low' }]);
    assert.equal(ctl.ui().notice, 'model change is off here');
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: an agent_model write refused because config.json changed on disk keeps the other writer\'s change, renders no agent file and leaves no temp file', async () => {
  const f = fixture({ models: { implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } } });
  const claudeAgent = join(f.dir, '.claude', 'agents', 'implementor.md');
  mkdirSync(join(f.dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(claudeAgent, '---\nname: implementor\nmodel: claude-sonnet-5-5\neffort: high\n---\nbody\n');
  const ocDir = join(f.dir, '.opencode', 'agents', 'sterling');
  mkdirSync(ocDir, { recursive: true });
  writeFileSync(join(ocDir, 'implementor.md'), 'portable\n');
  const concurrent = JSON.stringify({ models: { implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } }, tdd: { enabled: false } }, null, 2) + '\n';
  const ctl = openDashboard(f.storePath, { configWriteFs: { beforeRename: () => writeFileSync(f.configPath, concurrent) } });
  try {
    await ctl.applyEffects([{ type: 'agent_model', key: 'implementor', model: 'anthropic/claude-opus-5-5', effort: 'low' }]);
    assert.equal(readFileSync(f.configPath, 'utf8'), concurrent, "the other writer's change is not lost");
    assert.match(readFileSync(claudeAgent, 'utf8'), /^model: claude-sonnet-5-5$/m, 'the Claude agent file was not re-rendered');
    assert.equal(readFileSync(join(ocDir, 'implementor.md'), 'utf8'), 'portable\n', 'the OpenCode agent file was not re-rendered');
    assert.deepEqual(readdirSync(join(f.dir, '.sterling')).filter((n) => n.startsWith('config.json.')), []);
    assert.match(ctl.ui().notice ?? '', /^model change for 'implementor' failed — config\.json changed on disk while this write was in flight/);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// Restored from the pre-cutover auto-merge test: the keyboard path, now writing workflow.auto_merge_on_clean.
test('controller: the PR auto-merge row toggles workflow.auto_merge_on_clean from the keyboard, keeps pr_review.copilot_logins, and reloads the roster', async () => {
  const f = fixture({ workflow: { merge: 'pr', reviewers: 3, copilot_loop: true, auto_merge_on_clean: true }, pr_review: { copilot_logins: ['copilot-pull-request-reviewer[bot]'] }, tdd: { enabled: true } });
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.workflow?.auto_merge_on_clean, true);
    // the row is found by its id in the entry list the tab draws, then reached with DOWN like a user would
    const target = systemCursorOf(ctl.roster()!, ctl.ui(), 'sys:pr_auto_merge');
    assert.ok(target > 0, 'the auto-merge row is drawn and cursorable in a pr project');
    for (let i = 0; i < 60 && ctl.ui().cursor !== target; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    assert.equal(ctl.ui().cursor, target, 'DOWN reaches the auto-merge row');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    let written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.deepEqual(written.workflow, { merge: 'pr', reviewers: 3, copilot_loop: true, auto_merge_on_clean: false });
    assert.deepEqual(written.pr_review, { copilot_logins: ['copilot-pull-request-reviewer[bot]'] });
    assert.equal(ctl.roster()?.workflow?.auto_merge_on_clean, false, 'the roster reloads after the write');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(written.workflow.auto_merge_on_clean, true);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// Restored from storage-row.test.ts (removed with the cutover): the controller's raw read and the startup refusal.
async function rosterStorage(rawConfig: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-storage-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ tdd: { enabled: true } }));
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'));
  try {
    writeFileSync(configPath, rawConfig);
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    return ctl.roster()?.storage;
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the controller reads config.storage RAW for the row, keeping the four states separate', async () => {
  assert.equal(await rosterStorage('{"storage":"postgres"}'), 'postgres');
  assert.equal(await rosterStorage('{"storage":"sqlite"}'), 'sqlite');
  assert.equal(await rosterStorage('{"tdd":{"enabled":true}}'), undefined, 'absent stays undefined (SQLite default)');
  assert.equal(await rosterStorage('{"storage":"mysql"}'), 'mysql');
  assert.equal(await rosterStorage('{"storage":5}'), '5', 'a non-string value comes back as its JSON text');
  assert.equal(await rosterStorage('{ not json'), null, 'an unreadable config is null (UNKNOWN)');
  for (const junk of ['null', '[]', 'false', '0', '""', '5']) {
    assert.equal(await rosterStorage(junk), null, `a config of ${junk} parses but is not an object: UNKNOWN, never the SQLite default`);
  }
});

test('openDashboard refuses an unrecognized config.storage at startup, naming the key, the raw value and the valid values', () => {
  for (const [raw, shown] of [['"mysql"', '"mysql"'], ['5', '5'], ['"Postgres"', '"Postgres"']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-refuse-'));
    try {
      mkdirSync(join(dir, '.sterling'), { recursive: true });
      writeFileSync(join(dir, '.sterling', 'config.json'), `{"storage":${raw}}`);
      assert.throws(
        () => openDashboard(join(dir, '.sterling', 'sterling.db')),
        (e: unknown) => {
          const err = e as Error;
          assert.equal(err.name, 'StoreSettingsError');
          assert.ok(err.message.includes(`config.storage is ${shown}`), err.message);
          assert.ok(err.message.includes("must be 'sqlite' or 'postgres'"), err.message);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Restored from handoff-toggle.test.ts (removed with the cutover): the write-back round trip and its failure path.
test('applyHandoffToggle: writes config.handoff.enabled at the explicit path, keeps every other key, replaces a malformed block, and round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ project_name: 'x', workflow: { merge: 'direct' }, tdd: { enabled: false } }, null, 2));
    assert.equal(applyHandoffToggle({ type: 'handoff_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { project_name: 'x', workflow: { merge: 'direct' }, tdd: { enabled: false }, handoff: { enabled: true } });
    assert.equal(applyHandoffToggle({ type: 'handoff_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).handoff, { enabled: false });
    // a value that is not an object is replaced, never spread
    writeFileSync(cfgPath, JSON.stringify({ workflow: { merge: 'pr' }, handoff: 'yes' }));
    assert.equal(applyHandoffToggle({ type: 'handoff_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { workflow: { merge: 'pr' }, handoff: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyHandoffToggle: an unreadable config reports the failure through onError and returns false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-wb-'));
  try {
    const errors: string[] = [];
    const ok = applyHandoffToggle({ type: 'handoff_toggle', enabled: true }, (m) => errors.push(m), join(dir, 'missing', 'config.json'));
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /handoff toggle failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
