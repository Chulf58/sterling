import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
    // config.models defaults fill the top rows; the handoff files row is last
    // (DOWN clamps on it), the mode row sits above it and the tdd row above that.
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

// The handoff files row and the project mode row are separate switches (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// each writes only its own key, and each notice says only what that key decides.
for (const mode of ['hobby', 'work']) {
  test(`controller (${mode}): the handoff toggle writes config.handoff.enabled and leaves the mode alone; the mode toggle leaves handoff alone`, async () => {
    const f = fixture({ mode, tdd: { enabled: true } });
    const ctl = openDashboard(f.storePath);
    try {
      await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
      assert.equal(ctl.roster()?.handoff, false, 'no handoff key and nothing tracked reads off, in work mode too');
      for (let i = 0; i < 30; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
      await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
      let written = JSON.parse(readFileSync(f.configPath, 'utf8'));
      assert.deepEqual(written.handoff, { enabled: true }, 'config.handoff.enabled written');
      assert.equal(written.mode, mode, 'the mode is untouched');
      assert.equal(ctl.roster()?.handoff, true, 'the roster reloads after the write');
      assert.match(ctl.ui().notice ?? '', /^handoff files turned on — run \/sterling:update \(or init\)/);

      await ctl.handle({ kind: 'key', name: 'UP' }, VP);
      await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
      written = JSON.parse(readFileSync(f.configPath, 'utf8'));
      assert.equal(written.mode, mode === 'hobby' ? 'work' : 'hobby', 'the mode row flips the mode');
      assert.deepEqual(written.handoff, { enabled: true }, 'the handoff setting is untouched by a mode switch');
      assert.match(ctl.ui().notice ?? '', /^project mode set to /);
      assert.doesNotMatch(ctl.ui().notice ?? '', /OpenCode|handoff/i, 'the mode notice makes no claim about the handoff files');

      await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
      await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
      assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).handoff, { enabled: false });
      assert.match(ctl.ui().notice ?? '', /^handoff files turned off — .*NOT deleted/);
    } finally {
      ctl.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

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
test('controller: an OpenCode override writes config.models.<key>.opencode_model and the OpenCode agent only; the Claude agent file is unchanged', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high', hard_task: { model: 'claude-h' } } } });
  const ocDir = join(f.dir, '.opencode', 'agents', 'sterling');
  mkdirSync(ocDir, { recursive: true });
  const claudeAgent = join(f.dir, '.claude', 'agents', 'implementor.md');
  mkdirSync(join(f.dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(claudeAgent, '---\nname: implementor\nmodel: claude-a\neffort: high\n---\nbody\n');
  const claudeBefore = readFileSync(claudeAgent, 'utf8');
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'opencode_model', key: 'implementor', to: 'openai/gpt-5.6-terra', model: 'claude-a', effort: 'high', agents: ['implementor'] },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor, { model: 'claude-a', effort: 'high', hard_task: { model: 'claude-h' }, opencode_model: 'openai/gpt-5.6-terra' });
    assert.match(readFileSync(join(ocDir, 'implementor.md'), 'utf8'), /^model: openai\/gpt-5\.6-terra$/m);
    assert.equal(readFileSync(claudeAgent, 'utf8'), claudeBefore, 'the Claude Code agent file is byte-identical');
    assert.match(ctl.ui().notice ?? '', /set to openai\/gpt-5\.6-terra; Claude Code keeps claude-a/);
    const decisions = ctl.store.query({ types: ['decision'], cap: 10 }) as Array<{ title: string }>;
    assert.ok(decisions.some((d) => d.title === 'OpenCode model: implementor anthropic/claude-a→openai/gpt-5.6-terra (System tab)'), JSON.stringify(decisions.map((d) => d.title)));

    // a later Claude swap on the same key keeps the override, on disk and on OpenCode
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-a', effort: 'high' }, to: { model: 'claude-b', effort: 'low' }, agents: ['implementor'], decisionTitle: 't' },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor, { model: 'claude-b', effort: 'low', hard_task: { model: 'claude-h' }, opencode_model: 'openai/gpt-5.6-terra' });
    assert.deepEqual(readFileSync(join(ocDir, 'implementor.md'), 'utf8').match(/^model: .*$/gm), ['model: openai/gpt-5.6-terra']);

    // clearing the override returns the OpenCode agent to the role's Claude model
    await ctl.applyEffects([
      { type: 'opencode_model', key: 'implementor', from: 'openai/gpt-5.6-terra', model: 'claude-b', effort: 'low', agents: ['implementor'] },
    ]);
    assert.equal('opencode_model' in JSON.parse(readFileSync(f.configPath, 'utf8')).models.implementor, false);
    assert.deepEqual(readFileSync(join(ocDir, 'implementor.md'), 'utf8').match(/^model: .*$/gm), ['model: anthropic/claude-b']);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: an override for a key the config file does not carry writes the key with its current Claude values', async () => {
  const f = fixture();
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'opencode_model', key: 'reviewer', to: 'openai/gpt-6.1-sol', model: 'claude-opus-5-5', effort: 'high', agents: ['reviewer'] },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).models.reviewer, { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' });
    assert.equal(existsSync(join(f.dir, '.opencode')), false, 'no OpenCode agents installed, none created');
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: a malformed override is refused before config.json is written', async () => {
  const f = fixture({ models: { implementor: { model: 'claude-a', effort: 'high' } } });
  const before = readFileSync(f.configPath, 'utf8');
  const ctl = openDashboard(f.storePath);
  try {
    await ctl.applyEffects([
      { type: 'opencode_model', key: 'implementor', to: 'gpt-5.6-terra', model: 'claude-a', effort: 'high', agents: ['implementor'] },
    ]);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
    assert.match(ctl.ui().notice ?? '', /OpenCode model for 'implementor' failed/);
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
