import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalledHosts, outputPath, planCustomAgents, syncCustomAgents, translateTools } from '../lib/custom-agent-render.mjs';

const OPTS = {};
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
  // One model per agent (decision one-model-per-agent-an-agent-has-a-single-model-not-a-claude):
  // the entry names no model, so every host renders its own default and all three get a copy.
  // Before the settings redesign this entry carried model plus per-host opencode_model and
  // agy_model overrides; one model can no longer reach all three hosts, because agy runs only
  // agy/<id> models (rationale point (5)). The model lines per host are covered by
  // scripts/tests/host-fit-one-model.test.mjs.
  const p = project(source({ tools: 'Read, Grep, Glob', model: 'sonnet' }), { [KEY]: { effort: 'high' } });
  try {
    const first = sync(p);
    assert.deepEqual(first.refused, []);
    assert.deepEqual(first.written.map((w) => [w.host, w.path, w.status]), [
      ['claude', '.claude/agents/team-scout.md', 'created'],
      ['opencode', '.opencode/agents/team-scout.md', 'created'],
      ['agy', '.agents/agents/team-scout/agent.md', 'created'],
    ]);
    const claude = read(p.root, '.claude/agents/team-scout.md');
    assert.match(claude, /^model: sonnet$/m, 'the author model stays on the origin host');
    assert.match(claude, /^effort: high$/m);
    assert.match(claude, /^tools: Read, Grep, Glob$/m, 'the Claude copy keeps the author tools line');
    assert.match(claude, /<!-- sterling-custom renderer=custom-agent\/1 host=claude key=custom-team-scout source_hash=[0-9a-f]{64} content_hash=[0-9a-f]{64} -->/);
    const oc = read(p.root, '.opencode/agents/team-scout.md');
    assert.doesNotMatch(oc, /^model:/m);
    assert.doesNotMatch(oc, /effort/);
    assert.match(oc, /^permission:\n  "\*": deny\n  read: allow\n  grep: allow\n  glob: allow\n---/m);
    const agy = read(p.root, '.agents/agents/team-scout/agent.md');
    assert.match(agy, /^model: inherit$/m);
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

const rulesOf = (r) => r.rules.map((x) => `${x.action}:${x.verdict}`);

test('tool translation: what each host can and cannot express', () => {
  assert.deepEqual(translateTools('claude', { tools: 'mcp__x__y' }), { ok: true });
  assert.deepEqual(rulesOf(translateTools('opencode', { tools: 'Read, Grep, Glob' })), ['*:deny', 'read:allow', 'grep:allow', 'glob:allow']);
  assert.deepEqual(rulesOf(translateTools('opencode', { tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'WebSearch', 'Agent'] })), ['*:deny', 'read:allow', 'edit:allow', 'bash:allow', 'websearch:allow', 'task:allow']);
  assert.match(translateTools('opencode', { tools: 'Read, Edit' }).reason, /grants edit as one permission/);
  assert.match(translateTools('opencode', { tools: 'Read, Teleport' }).reason, /Teleport/);
  assert.match(translateTools('opencode', { tools: 'Read, mcp__sterling' }).reason, /whole server or a wildcard/);
  assert.match(translateTools('opencode', { tools: 'mcp__sterling__knowledge_*' }).reason, /whole server or a wildcard/);
  assert.deepEqual(rulesOf(translateTools('opencode', { disallowedTools: 'Bash' })), ['bash:deny']);
  assert.deepEqual(rulesOf(translateTools('opencode', {})), [], 'no tools line leaves the agent unrestricted');
  assert.deepEqual(rulesOf(translateTools('opencode', { disallowedTools: 'mcp__sterling__knowledge_create' })), ['sterling_knowledge_create:deny']);
  assert.deepEqual(translateTools('agy', { tools: 'Read, Grep' }), { ok: true, tools: ['read_file', 'grep_search'] });
  assert.match(translateTools('agy', { tools: 'Read, mcp__sterling__knowledge_query' }).reason, /cannot limit MCP/);
  assert.match(translateTools('agy', { tools: 'Read, NotebookEdit' }).reason, /no tool for NotebookEdit/);
  assert.equal(translateTools('agy', {}).tools, null);
  assert.ok(!translateTools('agy', { disallowedTools: 'Bash' }).tools.includes('run_command'));
});

test('OpenCode: a read-only allowlist is a deny-all and exactly its allows; no allow rule holds a wildcard', () => {
  const p = project(source({ tools: 'Read, Grep, Glob' }));
  try {
    sync(p, { hosts: ['opencode'] });
    const oc = read(p.root, '.opencode/agents/team-scout.md');
    assert.match(oc, /^---\ndescription: "Scouts the team folders"\nmode: subagent\npermission:\n  "\*": deny\n  read: allow\n  grep: allow\n  glob: allow\n---\n<!-- sterling-custom /);
    const permission = oc.split('permission:\n')[1].split('\n---')[0].split('\n');
    assert.deepEqual(permission.filter((l) => /: allow$/.test(l) && l.includes('*')), [], 'no allow rule holds a wildcard');
    assert.equal(permission.filter((l) => l.includes('*')).length, 1, 'the leading deny-all is the only wildcard');
  } finally {
    p.done();
  }
});

test('OpenCode: an MCP allowlist entry renders as <server>_<tool>, normalized, and a deny wins over an allow', () => {
  const p = project(source({ tools: 'Read, mcp__sterling__knowledge_query, mcp__my.server__do-it, mcp__sterling__knowledge_create', disallowedTools: 'mcp__sterling__knowledge_create' }));
  try {
    const r = sync(p, { hosts: ['opencode', 'agy'] });
    const oc = read(p.root, '.opencode/agents/team-scout.md');
    assert.match(oc, /\n {2}"\*": deny\n {2}read: allow\n {2}sterling_knowledge_query: allow\n {2}my_server_do-it: allow\n {2}sterling_knowledge_create: deny\n---/);
    assert.ok(!/sterling_knowledge_create: allow/.test(oc));
    assert.match(r.refused.find((x) => x.host === 'agy').reason, /cannot limit MCP/, 'agy keeps its refusal');
  } finally {
    p.done();
  }
});

test('a host that cannot express a restriction refuses that host only, never renders broader', () => {
  const p = project(source({ tools: 'Read, Edit' }));
  try {
    const r = sync(p);
    assert.deepEqual(r.written.map((w) => w.host), ['claude', 'agy']);
    assert.match(r.refused.find((x) => x.host === 'opencode').reason, /grants edit as one permission/);
    assert.equal(existsSync(join(p.root, '.opencode/agents/team-scout.md')), false);
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

// System tab redesign item 5: the sync and retirement paths must not treat a generated custom agent as foreign.
test('retireAgents leaves a sterling-custom generated file alone: only a sterling-generated, unmodified retired agent is removed', async () => {
  const { retireAgents } = await import('../lib/agent-distribution.mjs');
  const p = project();
  try {
    sync(p);
    const dir = join(p.root, '.claude', 'agents');
    const before = read(p.root, '.claude/agents/team-scout.md');
    const report = retireAgents({ targetAgentsDir: dir, registryNames: new Set() });
    assert.deepEqual(report, [], 'no retirement and no refusal for the custom copy');
    assert.equal(read(p.root, '.claude/agents/team-scout.md'), before, 'the generated file is still there, unchanged');
  } finally {
    p.done();
  }
});

// ── review fixes (feat/system-tab-redesign): origin host, never broader, cleanup by desired set ──

const ocSource = (permissionBlock, extra = '') => `---\nsterling-origin: opencode\ndescription: "Scouts the team folders"\nmode: subagent\n${extra}${permissionBlock}---\nFind things.\n`;

test('an OpenCode-origin source keeps its "*": deny / read: allow on OpenCode and is translated, never dropped, for Claude and agy', () => {
  const p = project(ocSource('permission:\n  "*": deny\n  read: allow\n'));
  try {
    const r = sync(p);
    assert.deepEqual(r.refused, []);
    const oc = read(p.root, '.opencode/agents/team-scout.md');
    assert.match(oc, /^permission:\n {2}"\*": deny\n {2}read: allow$/m, 'the author permission block stays on its own host');
    assert.doesNotMatch(oc, /sterling-origin/, 'the origin marker is Sterling bookkeeping, never rendered');
    const claude = read(p.root, '.claude/agents/team-scout.md');
    assert.match(claude, /^tools: Read$/m, 'Claude gets the same allowlist');
    assert.doesNotMatch(claude, /permission|sterling-origin|mode: subagent/);
    const agy = read(p.root, '.agents/agents/team-scout/agent.md');
    assert.match(agy, /^tools:\n {2}- read_file\n---/m);
  } finally {
    p.done();
  }
});

test('an OpenCode-origin edit/bash deny becomes disallowedTools on Claude and a narrowed tool list on agy', () => {
  const p = project(ocSource('permission:\n  edit: deny\n  bash: deny\n'));
  try {
    const r = sync(p);
    assert.deepEqual(r.refused, []);
    assert.match(read(p.root, '.opencode/agents/team-scout.md'), /^permission:\n {2}edit: deny\n {2}bash: deny$/m);
    assert.match(read(p.root, '.claude/agents/team-scout.md'), /^disallowedTools: Edit, Write, MultiEdit, Bash$/m);
    const agy = read(p.root, '.agents/agents/team-scout/agent.md');
    assert.doesNotMatch(agy, /edit_file|write_file|run_command|multi_replace_file_content/);
    assert.match(agy, /- read_file/);
  } finally {
    p.done();
  }
});

test('an OpenCode V2 permissions list is honoured, and a rule no other host can express refuses that host only', () => {
  const v2 = ocSource('permissions:\n  - { action: "*", resource: "*", effect: deny }\n  - { action: read, resource: "*", effect: allow }\n  - { action: shell, resource: "*", effect: allow }\n');
  const p = project(v2);
  try {
    const r = sync(p);
    assert.deepEqual(r.refused, []);
    assert.match(read(p.root, '.claude/agents/team-scout.md'), /^tools: Read, Bash$/m);
    // ask, a per-command pattern and an MCP rule have no faithful form outside OpenCode
    for (const block of ['permission:\n  bash: ask\n', 'permission:\n  bash:\n    "*": deny\n    "git status": allow\n', 'permission:\n  "*": deny\n  sterling_knowledge_query: allow\n']) {
      writeFileSync(join(p.root, 'agent-sources', `${KEY}.md`), ocSource(block));
      const again = sync(p);
      assert.deepEqual(again.refused.map((x) => x.host).sort(), ['agy', 'claude'], block);
      assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false, `the broader Claude copy is removed (${block})`);
      assert.match(read(p.root, '.opencode/agents/team-scout.md'), new RegExp(block.split('\n')[1].trim().replace(/[.*"]/g, '.')), 'the origin host still gets its own rules');
    }
  } finally {
    p.done();
  }
});

test('an agy-origin tools list is translated back to Claude names', () => {
  const p = project('---\nsterling-origin: agy\nname: team-scout\ndescription: "Scouts"\nmodel: flash\ntools:\n  - read_file\n  - grep_search\n---\nFind.\n');
  try {
    const r = sync(p);
    assert.deepEqual(r.refused, []);
    assert.match(read(p.root, '.claude/agents/team-scout.md'), /^tools: Read, Grep$/m);
    assert.match(read(p.root, '.opencode/agents/team-scout.md'), /"\*": deny\n {2}read: allow\n {2}grep: allow/);
    assert.match(read(p.root, '.agents/agents/team-scout/agent.md'), /^model: flash$/m, 'agy keeps the author model');
  } finally {
    p.done();
  }
});

test('tightening a source so a host refuses removes the earlier broader copy Sterling wrote; an edited one is kept with a warning', () => {
  const p = project(source());
  try {
    sync(p);
    assert.ok(existsSync(join(p.root, '.opencode/agents/team-scout.md')));
    const agyPath = join(p.root, '.agents/agents/team-scout/agent.md');
    writeFileSync(agyPath, `${readFileSync(agyPath, 'utf8')}hand edit\n`);
    // Read + Edit without Write: OpenCode cannot express it; agy has no NotebookEdit
    writeFileSync(join(p.root, 'agent-sources', `${KEY}.md`), source({ tools: 'Read, Edit, NotebookEdit' }));
    const r = sync(p);
    assert.equal(existsSync(join(p.root, '.opencode/agents/team-scout.md')), false, 'the unrestricted OpenCode copy is gone');
    assert.deepEqual(r.removed.map((x) => x.host), ['opencode']);
    assert.ok(existsSync(agyPath), 'an edited copy is never deleted');
    assert.ok(r.refused.some((x) => x.host === 'agy' && /edited after Sterling wrote it/.test(x.reason) && /still installed/.test(x.reason)), JSON.stringify(r.refused));
  } finally {
    p.done();
  }
});

test('renaming the agent in its frontmatter moves the outputs: the old Sterling copies are removed', () => {
  const p = project(source());
  try {
    sync(p);
    writeFileSync(join(p.root, 'agent-sources', `${KEY}.md`), source({ name: 'team-finder' }));
    const r = sync(p);
    assert.deepEqual(r.refused, []);
    assert.equal(r.removed.length, 3);
    for (const h of ALL) {
      assert.equal(existsSync(join(p.root, outputPath(h, 'team-scout'))), false, `${h} old copy removed`);
      assert.ok(existsSync(join(p.root, outputPath(h, 'team-finder'))), `${h} new copy written`);
    }
  } finally {
    p.done();
  }
});

test('requireClean: a refusal for a named key throws before anything is written', () => {
  const p = project(source({ tools: 'Read, Edit' }));
  try {
    assert.throws(() => sync(p, { requireClean: [KEY] }), /opencode: .*grants edit as one permission/);
    assert.equal(existsSync(join(p.root, '.claude')), false, 'nothing written for the hosts that would have rendered');
  } finally {
    p.done();
  }
});

test('hasCustomOutputs sees a stamped copy even when no config key is left', async () => {
  const { hasCustomOutputs } = await import('../lib/custom-agent-render.mjs');
  const p = project();
  try {
    assert.equal(hasCustomOutputs(p.root), false);
    sync(p, { hosts: ['claude'] });
    assert.equal(hasCustomOutputs(p.root), true);
  } finally {
    p.done();
  }
});
