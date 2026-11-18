import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalledHosts, outputPath, planCustomAgents, syncCustomAgents, translateTools } from '../lib/custom-agent-render.mjs';

const DENIES = ['sterling_knowledge_create'];
const OPTS = { storeWriteDenies: DENIES };
const ALL = ['claude', 'opencode', 'agy'];
const KEY = 'custom-team-scout';

const source = (fm = {}, body = 'Find things.\n') => {
  const lines = { name: 'team-scout', description: 'Scouts the team folders', ...fm };
  return `---\n${Object.entries(lines).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
};

function project(src = source(), models = { [KEY]: {} }) {
  const root = mkdtempSync(join(tmpdir(), 'custom-render-'));
  mkdirSync(join(root, 'agent-sources'), { recursive: true });
  if (src !== null) writeFileSync(join(root, 'agent-sources', `${KEY}.md`), src);
  return { root, config: { models }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const sync = (p, extra = {}) => syncCustomAgents(p.root, p.config, { hosts: ALL, ...OPTS, ...extra });

test('renders one agent to all three hosts with a stamp, and a second run changes nothing', () => {
  const p = project(source({ tools: 'Read, Grep, Glob', model: 'sonnet' }), { [KEY]: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol', agy_model: 'pro' } });
  try {
    const first = sync(p);
    assert.deepEqual(first.refused, []);
    assert.deepEqual(first.written.map((w) => [w.host, w.path, w.status]), [
      ['claude', '.claude/agents/team-scout.md', 'created'],
      ['opencode', '.opencode/agents/team-scout.md', 'created'],
      ['agy', '.agents/agents/team-scout/agent.md', 'created'],
    ]);
    const claude = read(p.root, '.claude/agents/team-scout.md');
    assert.match(claude, /^model: claude-opus-5-5$/m);
    assert.match(claude, /^effort: high$/m);
    assert.match(claude, /^tools: Read, Grep, Glob$/m, 'the Claude copy keeps the author tools line');
    assert.match(claude, /<!-- sterling-custom renderer=custom-agent\/1 host=claude key=custom-team-scout source_hash=[0-9a-f]{64} content_hash=[0-9a-f]{64} -->/);
    const oc = read(p.root, '.opencode/agents/team-scout.md');
    assert.match(oc, /^model: openai\/gpt-6.1-sol$/m);
    assert.doesNotMatch(oc, /effort/);
    assert.match(oc, /^  edit: deny$/m);
    assert.match(oc, /^  bash: deny$/m);
    assert.match(oc, /^  sterling_knowledge_create: deny$/m);
    const agy = read(p.root, '.agents/agents/team-scout/agent.md');
    assert.match(agy, /^model: pro$/m);
    assert.match(agy, /^ {2}- read_file$/m);
    assert.doesNotMatch(agy, /run_command|effort/);
    const second = sync(p);
    assert.deepEqual([second.written, second.removed, second.refused], [[], [], []]);
    assert.equal(second.unchanged.length, 3);
  } finally {
    p.done();
  }
});

test('a config entry with no model or effort inherits: the source values stay, OpenCode and agy get no model pin', () => {
  const p = project(source({ model: 'sonnet', effort: 'low' }));
  try {
    sync(p);
    const claude = read(p.root, '.claude/agents/team-scout.md');
    assert.match(claude, /^model: sonnet$/m);
    assert.match(claude, /^effort: low$/m);
    assert.doesNotMatch(read(p.root, '.opencode/agents/team-scout.md'), /^model:/m, 'an alias is not an OpenCode model');
    assert.match(read(p.root, '.agents/agents/team-scout/agent.md'), /^model: inherit$/m);
    assert.doesNotMatch(read(p.root, '.opencode/agents/team-scout.md'), /permission:/, 'no tools line, no restriction');
  } finally {
    p.done();
  }
});

test('OpenCode takes a full claude id from the source as anthropic/<id> when config names none', () => {
  const p = project(source({ model: 'claude-sonnet-5-5' }));
  try {
    sync(p, { hosts: ['opencode'] });
    assert.match(read(p.root, '.opencode/agents/team-scout.md'), /^model: anthropic\/claude-sonnet-5-5$/m);
  } finally {
    p.done();
  }
});

test('tool translation: what each host can and cannot express', () => {
  assert.deepEqual(translateTools('claude', { tools: 'mcp__x__y' }), { ok: true });
  const oc = translateTools('opencode', { tools: 'Read, Grep' });
  assert.deepEqual(oc, { ok: true, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny' }, storeDeny: true });
  assert.deepEqual(translateTools('opencode', { tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Bash'] }).permission, { webfetch: 'deny', websearch: 'deny', task: 'deny' });
  assert.match(translateTools('opencode', { tools: 'Read, Edit' }).reason, /grants edit as one permission/);
  assert.match(translateTools('opencode', { tools: 'Read, mcp__sterling__knowledge_query' }).reason, /MCP tool entry/);
  assert.match(translateTools('opencode', { tools: 'Read, Teleport' }).reason, /Teleport/);
  assert.deepEqual(translateTools('opencode', { disallowedTools: 'Bash' }), { ok: true, permission: { bash: 'deny' }, storeDeny: false });
  assert.deepEqual(translateTools('agy', { tools: 'Read, Grep' }), { ok: true, tools: ['read_file', 'grep_search'] });
  assert.match(translateTools('agy', { tools: 'Read, mcp__sterling__knowledge_query' }).reason, /cannot limit MCP/);
  assert.match(translateTools('agy', { tools: 'Read, NotebookEdit' }).reason, /no tool for NotebookEdit/);
  assert.equal(translateTools('agy', {}).tools, null);
  assert.ok(!translateTools('agy', { disallowedTools: 'Bash' }).tools.includes('run_command'));
});

test('an allowlist a host cannot express refuses that host only, never renders broader', () => {
  const p = project(source({ tools: 'Read, mcp__sterling__knowledge_query' }));
  try {
    const r = sync(p);
    assert.deepEqual(r.written.map((w) => w.host), ['claude']);
    assert.deepEqual(r.refused.map((x) => x.host).sort(), ['agy', 'opencode']);
    assert.match(r.refused.find((x) => x.host === 'agy').reason, /MCP/);
    assert.equal(existsSync(join(p.root, '.opencode/agents/team-scout.md')), false);
    assert.equal(existsSync(join(p.root, '.agents/agents/team-scout')), false);
    const hooks = project(source({ hooks: 'x' }));
    try {
      assert.match(sync(hooks).refused.find((x) => x.host === 'opencode').reason, /hooks/);
    } finally {
      hooks.done();
    }
  } finally {
    p.done();
  }
});

test('refuses an unstamped file and an edited copy, naming the source, and leaves both alone', () => {
  const p = project();
  try {
    mkdirSync(join(p.root, '.claude/agents'), { recursive: true });
    writeFileSync(join(p.root, '.claude/agents/team-scout.md'), 'mine\n');
    const r = sync(p);
    const claude = r.refused.find((x) => x.host === 'claude');
    assert.match(claude.reason, /no Sterling stamp/);
    assert.match(claude.reason, /agent-sources\/custom-team-scout\.md/);
    assert.equal(read(p.root, '.claude/agents/team-scout.md'), 'mine\n');
    // the other hosts still rendered; edit one generated copy
    const ocPath = join(p.root, '.opencode/agents/team-scout.md');
    writeFileSync(ocPath, `${readFileSync(ocPath, 'utf8')}extra line\n`);
    const again = sync(p);
    assert.match(again.refused.find((x) => x.host === 'opencode').reason, /edited after Sterling wrote it.*agent-sources\/custom-team-scout\.md/);
    assert.match(readFileSync(ocPath, 'utf8'), /extra line/);
  } finally {
    p.done();
  }
});

test('a changed source refreshes an unedited copy', () => {
  const p = project();
  try {
    sync(p);
    writeFileSync(join(p.root, 'agent-sources', `${KEY}.md`), source({}, 'New body.\n'));
    const r = sync(p);
    assert.deepEqual(r.written.map((w) => w.status), ['refreshed', 'refreshed', 'refreshed']);
    assert.match(read(p.root, '.claude/agents/team-scout.md'), /New body\./);
  } finally {
    p.done();
  }
});

test('output name collisions: with a governed role and between two custom agents', () => {
  const p = project(source({ name: 'scout' }));
  try {
    const r = sync(p);
    assert.match(r.refused[0].reason, /belongs to a Sterling role/);
    assert.deepEqual(r.written, []);
    writeFileSync(join(p.root, 'agent-sources', 'custom-other.md'), source({ name: 'team-scout' }));
    writeFileSync(join(p.root, 'agent-sources', `${KEY}.md`), source());
    const both = syncCustomAgents(p.root, { models: { [KEY]: {}, 'custom-other': {} } }, { hosts: ALL, ...OPTS });
    assert.equal(both.refused.length, 2);
    assert.match(both.refused[0].reason, /also the output name of/);
    assert.deepEqual(both.written, []);
  } finally {
    p.done();
  }
});

test('removal: dropping the config entry or the source removes only stamped, unedited outputs', () => {
  const p = project();
  try {
    sync(p);
    writeFileSync(join(p.root, '.claude/agents/mine.md'), 'not generated\n');
    const ocPath = join(p.root, '.opencode/agents/team-scout.md');
    writeFileSync(ocPath, `${readFileSync(ocPath, 'utf8')}edited\n`);
    const r = syncCustomAgents(p.root, { models: {} }, { hosts: ALL, ...OPTS });
    assert.deepEqual(r.removed.map((x) => x.host).sort(), ['agy', 'claude']);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].reason, /edited after Sterling wrote it/);
    assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false);
    assert.equal(existsSync(join(p.root, '.agents/agents/team-scout')), false, 'the emptied agy folder goes too');
    assert.equal(existsSync(ocPath), true, 'an edited copy is kept');
    assert.equal(read(p.root, '.claude/agents/mine.md'), 'not generated\n');
    assert.deepEqual(r.skipped, [{ key: KEY, reason: 'config.models has no custom-team-scout entry' }]);
  } finally {
    p.done();
  }
});

test('removing the source file removes the outputs', () => {
  const p = project();
  try {
    sync(p);
    rmSync(join(p.root, 'agent-sources', `${KEY}.md`));
    const r = sync(p);
    assert.equal(r.removed.length, 3);
    assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false);
  } finally {
    p.done();
  }
});

test('refuses to write through a symlinked folder or read a symlinked source', () => {
  const p = project();
  const other = mkdtempSync(join(tmpdir(), 'custom-render-other-'));
  try {
    mkdirSync(join(p.root, '.opencode'));
    symlinkSync(other, join(p.root, '.opencode/agents'));
    const r = sync(p);
    const oc = r.refused.find((x) => x.host === 'opencode');
    assert.match(oc.reason, /symlink/);
    assert.equal(existsSync(join(other, 'team-scout.md')), false);
    assert.equal(r.written.length, 2);
    rmSync(join(p.root, 'agent-sources', `${KEY}.md`));
    writeFileSync(join(other, 'src.md'), source());
    symlinkSync(join(other, 'src.md'), join(p.root, 'agent-sources', `${KEY}.md`));
    const linked = syncCustomAgents(p.root, p.config, { hosts: ['claude'], ...OPTS });
    assert.match(linked.refused[0].reason, /source|symlink/);
  } finally {
    p.done();
    rmSync(other, { recursive: true, force: true });
  }
});

test('a write that fails partway puts the earlier writes back', () => {
  const p = project();
  try {
    // a directory where the agy file must go makes that write fail after claude and opencode landed
    mkdirSync(join(p.root, '.agents/agents/team-scout/agent.md'), { recursive: true });
    const plan = planCustomAgents(p.root, p.config, { hosts: ALL, ...OPTS });
    assert.ok(plan.refused.some((x) => x.host === 'agy' && /not a file/.test(x.reason)), 'the directory is refused at plan time');
    // force the failure path: a parent that is a file
    rmSync(join(p.root, '.agents'), { recursive: true });
    writeFileSync(join(p.root, '.agents'), 'a file, not a folder');
    assert.throws(() => sync(p));
    assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false, 'earlier writes rolled back');
    assert.equal(existsSync(join(p.root, '.opencode/agents/team-scout.md')), false);
  } finally {
    p.done();
  }
});

test('dry run reports exactly what the real run does and writes nothing', () => {
  const p = project();
  try {
    const dry = sync(p, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(existsSync(join(p.root, '.claude')), false);
    const real = sync(p);
    const { dryRun: a, ...dryRest } = dry;
    const { dryRun: b, ...realRest } = real;
    assert.deepEqual(dryRest, realRest);
    assert.deepEqual(a, true);
    assert.deepEqual(b, false);
    const dry2 = sync(p, { dryRun: true });
    assert.equal(dry2.written.length, 0);
    assert.equal(dry2.unchanged.length, 3);
  } finally {
    p.done();
  }
});

test('installed hosts come from .claude and the OpenCode and agy probes', () => {
  const p = project();
  try {
    const probes = { opencode: () => ({ installed: true }), agy: () => ({ installed: false }) };
    assert.deepEqual(detectInstalledHosts(p.root, { probes }), ['opencode']);
    mkdirSync(join(p.root, '.claude'));
    assert.deepEqual(detectInstalledHosts(p.root, { probes: { ...probes, agy: () => ({ installed: true }) } }), ['claude', 'opencode', 'agy']);
    assert.equal(outputPath('agy', 'x'), '.agents/agents/x/agent.md');
  } finally {
    p.done();
  }
});

test('generated copies are not discovered as custom agents', async () => {
  const p = project();
  try {
    sync(p);
    const { discoverCustomAgents } = await import('../../packages/tui/dist/custom-agents.js');
    assert.deepEqual(discoverCustomAgents(p.root), []);
  } finally {
    p.done();
  }
});
