// Settings redesign item B (board 5250a56c; decision
// settings-redesign-build-shape-one-legacy-to-canonical-config): every dispatch and every host
// copy follows the agent's ONE canonical model. Covers the dispatch resolver (one model, the
// overpass/<tier> namespace, the two-model refusal), host fit (unsupportedAgents), stale-copy
// removal with edited copies kept, the agy mcpServers refusal and the quoted origin key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalModelsSchema, hostRunsModel, resolveHostSettings, unsupportedAgents } from '@sterling/schemas';
import { dispatchModel, projectRouting, resolveDispatchModel } from '../../packages/opencode-plugin/src/dispatch-model.mjs';
import { desiredOverlay, expectedSessionModel, overpassResolution } from '../../packages/opencode-plugin/src/overpass.mjs';
import { syncAgents } from '../lib/agent-distribution.mjs';
import { syncCustomAgents } from '../lib/custom-agent-render.mjs';
import { ensureAgyAgents, readAgyFit, renderAgyAgent } from '../lib/agy-setup.mjs';
import { buildWorkerArgs, workerModelOf } from '../hooks/lib/maintenance-worker.mjs';

const scratch = (p) => mkdtempSync(join(tmpdir(), p));

// ── dispatch resolver ───────────────────────────────────────────────────────

test('dispatch: one model per agent, its effort as the variant; a legacy bare Claude id reads as anthropic/<id>', () => {
  const routing = projectRouting({ models: { implementor: { model: 'openai/gpt-5.6-terra', effort: 'high' }, scout: { model: 'claude-sonnet-5-5', effort: 'low' }, researcher: { model: 'anthropic/claude-opus-5-5' } } });
  assert.equal(dispatchModel(routing, { agent: 'sterling/implementor', prompt: 'x' }).model, 'openai/gpt-5.6-terra#high');
  assert.equal(dispatchModel(routing, { agent: 'sterling/scout', prompt: 'x' }).model, 'anthropic/claude-sonnet-5-5#low');
  assert.equal(dispatchModel(routing, { agent: 'sterling/researcher', prompt: 'x' }).model, 'anthropic/claude-opus-5-5', 'an unset effort sends no variant');
  assert.equal(dispatchModel(routing, { agent: 'general', prompt: 'x' }).model, null, 'an agent with no model is left alone');
  const named = dispatchModel(routing, { agent: 'sterling/implementor', model: 'anthropic/claude-opus-5-5', prompt: 'x' });
  assert.equal(named.model, null, 'a model the call names is kept');
  assert.match(named.line, /kept anthropic\/claude-opus-5-5 as the call named; config\.models\.implementor gives openai\/gpt-5\.6-terra#high/);
});

test('dispatch: MODEL-INTENT and OVERPASS-BYPASS lines are plain text now, never parsed or refused', () => {
  const routing = projectRouting({ models: { reviewer: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  for (const line of ['MODEL-INTENT: review-of=openai', 'MODEL-INTENT: nonsense', 'OVERPASS-BYPASS:']) {
    assert.equal(dispatchModel(routing, { agent: 'sterling/reviewer', prompt: `Review.\n${line}\n` }).model, 'openai/gpt-6.1-sol#high', line);
  }
});

test('dispatch: overpass/<tier> maps through config.overpass.provider, without a variant, and is marked for the availability check', () => {
  const routing = projectRouting({ overpass: { provider: 'gw' }, models: { reviewer: { model: 'overpass/agentic-high', effort: 'xhigh' } } });
  const pin = dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'x' });
  assert.equal(pin.model, 'gw/agentic-high');
  assert.equal(pin.overpass, true);
  assert.match(pin.line, /Overpass tier overpass\/agentic-high on provider 'gw' with effort xhigh/);
  assert.equal(projectRouting({ models: { scout: { model: 'overpass/agentic-auto' } } }).entries.scout.model, 'overpass/agentic-auto', 'the default provider is overpass');
});

test('dispatch: a legacy effective Overpass (work mode, enabled) routes each role on its resolved tier', () => {
  const routing = projectRouting({ mode: 'work', overpass: { enabled: true, provider: 'op' } });
  assert.equal(resolveDispatchModel('implementor', routing).ref, 'op/agentic-auto');
  assert.equal(resolveDispatchModel('implementor-hard', routing).ref, 'op/agentic-premium');
});

test('dispatch: a role with two legacy models refuses loudly, on neither model; a resume keeps its session', () => {
  const routing = projectRouting({ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } });
  assert.throws(() => dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'Review.' }), (e) => {
    assert.equal(e.message, 'Sterling refused this subagent dispatch: role reviewer has two models; run /sterling:update to choose. Nothing was sent, on either model.');
    return true;
  });
  assert.throws(() => dispatchModel(routing, { agent: 'sterling/reviewer', model: 'openai/gpt-6.1-sol', prompt: 'x' }), /two models/, 'a named model does not get around it');
  assert.equal(dispatchModel(routing, { agent: 'sterling/reviewer', sessionID: 'ses_1', prompt: 'x' }).model, null);
  assert.equal(dispatchModel(routing, { agent: 'sterling/scout', prompt: 'x' }).model, 'anthropic/claude-sonnet-5-5#low', 'other roles still dispatch');
});

test('dispatch: an invalid entry never refuses and never guesses', () => {
  const pin = dispatchModel(projectRouting({ models: { scout: { model: 'no slash or catalog' } } }), { agent: 'sterling/scout', prompt: 'x' });
  assert.equal(pin.model, null);
  assert.match(pin.notice, /config\.models is invalid \(config\.models\.scout\.model/);
});

// ── conductor and Plan overlay from their own selections ─────────────────────

test('overlay: plan and conductor come from models.plan and models.conductor, a non-tier effort as the variant', () => {
  const res = overpassResolution(projectRouting({ overpass: { provider: 'gw' }, models: { plan: { model: 'overpass/agentic-high', effort: 'max' }, conductor: { model: 'openai/gpt-6.1-sol', effort: 'high' } } }));
  assert.deepEqual(desiredOverlay(res), { plan: { model: 'gw/agentic-high' }, 'sterling/conductor': { model: 'openai/gpt-6.1-sol', variant: 'high' } });
  assert.equal(expectedSessionModel(res, 'plan'), 'gw/agentic-high');
  assert.equal(res.effective, true);
  const none = overpassResolution(projectRouting({ models: { implementor: { model: 'overpass/agentic-auto' } } }));
  assert.deepEqual(desiredOverlay(none), {}, 'no selection, no overlay entry, whatever other agents run on');
  assert.equal(expectedSessionModel(none, 'sterling/conductor'), null);
});

// ── host fit ────────────────────────────────────────────────────────────────

// agy runs only its own models, agy/<id> (user-ruled, decision
// one-model-per-agent-an-agent-has-a-single-model-not-a-claude point (5), "No agy copy, fail loudly").
test('host fit: Claude runs anthropic only, agy its own agy/<id> models only, OpenCode anything but agy/', () => {
  assert.equal(hostRunsModel('anthropic/claude-haiku-5-5', 'claude'), true);
  assert.equal(hostRunsModel('claude-haiku-5-5', 'claude'), true, 'a bare id is a Claude id');
  assert.equal(hostRunsModel('openai/gpt-6.1-sol', 'claude'), false);
  assert.equal(hostRunsModel('overpass/agentic-auto', 'claude'), false);
  assert.equal(hostRunsModel('anthropic/claude-opus-5-5', 'agy'), false, 'an Opus agent gets no agy copy');
  assert.equal(hostRunsModel('anthropic/claude-haiku-5-5', 'agy'), false);
  assert.equal(hostRunsModel('agy/flash', 'agy'), true);
  assert.equal(hostRunsModel('agy/ultra', 'agy'), false, 'only the four agy ids');
  assert.equal(hostRunsModel('agy/flash', 'claude'), false);
  assert.equal(hostRunsModel('agy/flash', 'opencode'), false);
  assert.equal(hostRunsModel('overpass/agentic-auto', 'opencode'), true);
  assert.equal(canonicalModelsSchema.safeParse({ scout: { model: 'agy/flash_lite' } }).success, true, 'the canonical schema accepts the four agy ids');
  assert.match(canonicalModelsSchema.safeParse({ scout: { model: 'agy/ultra' } }).error.issues[0].message, /is not an agy model: after agy\/ it must be one of inherit, flash_lite, flash, pro/);
  assert.deepEqual(resolveHostSettings({ model: 'anthropic/claude-opus-5-5', effort: 'high' }, 'claude'), { host: 'claude', model: 'claude-opus-5-5', modelFrom: 'model', modelSupported: true, effortSupported: true, effort: 'high' });
  assert.equal(resolveHostSettings({ model: 'openai/gpt-6.1-sol' }, 'claude').modelSupported, false);
  assert.equal(resolveHostSettings({ model: 'anthropic/claude-sonnet-5-5' }, 'agy').modelSupported, false);
  assert.equal(resolveHostSettings({ model: 'agy/flash_lite' }, 'agy').model, 'flash_lite', 'agy files name the bare value');
});

test('unsupportedAgents lists each agent a host cannot run, and a two-model role once, for the session line and the TUI', () => {
  const rows = unsupportedAgents({ models: { reviewer: { model: 'openai/gpt-6.1-sol' }, plan: { model: 'overpass/agentic-high' }, sparring: { model: 'claude-opus-5-5', opencode_model: 'openai/gpt-6-astra' } } }, ['claude', 'opencode']);
  assert.deepEqual(rows, [
    { agent: 'sparring', host: '*', reason: 'role sparring has two models; run /sterling:update to choose' },
    { agent: 'reviewer', host: 'claude', model: 'openai/gpt-6.1-sol', reason: 'claude cannot run openai/gpt-6.1-sol, so it gets no copy of reviewer' },
  ], 'plan is judged on OpenCode only, and OpenCode runs every provider');
  const agyRows = unsupportedAgents({ models: { scout: { model: 'agy/flash' } } }, ['agy']);
  assert.ok(agyRows.some((r) => r.agent === 'reviewer' && r.reason === 'agy cannot run anthropic/claude-opus-5-5, so it gets no copy of reviewer'), 'an Opus agent is listed for agy');
  assert.ok(!agyRows.some((r) => r.agent === 'scout'), 'an agy/flash agent is not');
  assert.ok(unsupportedAgents({ models: { scout: { model: 'agy/flash' } } }, ['claude']).some((r) => r.agent === 'scout' && r.model === 'agy/flash'));
});

// ── Claude roster: stale copy removed, edited copy kept ─────────────────────

const REVIEWER = `---\nname: reviewer\ndescription: Reviews.\nmodel: {{MODEL}}\neffort: {{EFFORT}}\ntools: Read\n---\n\nReview body.\n`;
const SCOUT = `---\nname: scout\ndescription: Scouts.\nmodel: {{MODEL}}\neffort: {{EFFORT}}\ntools: Read\n---\n\nScout body.\n`;

function rosterFixture() {
  const dir = scratch('host-fit-roster-');
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'reviewer.md'), REVIEWER);
  writeFileSync(join(templatesDir, 'scout.md'), SCOUT);
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'reviewer', file: 'reviewer.md' }, { name: 'scout', file: 'scout.md' }] }));
  const targetAgentsDir = join(dir, '.claude', 'agents');
  const run = (models) => syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: '2026-01-01T00:00:00.000Z', config: { models } });
  return { dir, targetAgentsDir, run };
}
const CLAUDE_MODELS = { reviewer: { model: 'claude-opus-5-5', effort: 'high' }, scout: { model: 'claude-sonnet-5-5', effort: 'low' } };

test('Claude roster: an agent moved to a model Claude Code cannot run loses its unedited copy; an unset effort drops the effort line', () => {
  const f = rosterFixture();
  try {
    f.run(CLAUDE_MODELS);
    assert.match(readFileSync(join(f.targetAgentsDir, 'reviewer.md'), 'utf8'), /^model: claude-opus-5-5$/m);
    const { report } = f.run({ ...CLAUDE_MODELS, reviewer: { model: 'openai/gpt-6.1-sol', effort: 'high' }, scout: { model: 'anthropic/claude-sonnet-5-5' } });
    assert.equal(existsSync(join(f.targetAgentsDir, 'reviewer.md')), false);
    assert.deepEqual(report.find((r) => r.name === 'reviewer'), { name: 'reviewer', status: 'unsupported_removed', detail: 'config.models.reviewer is openai/gpt-6.1-sol, which Claude Code cannot run (it runs anthropic models only)' });
    // sync reports a model change on an up-to-date copy as config_drift and does not write it;
    // the configured render carries no effort line once the effort is unset
    const scout = report.find((r) => r.name === 'scout');
    assert.equal(scout.status, 'config_drift');
    assert.equal(scout.configured.model, 'claude-sonnet-5-5');
    assert.equal(scout.configured.effort, null, 'no effort line in the configured render');
    assert.equal(f.run({ ...CLAUDE_MODELS, reviewer: { model: 'openai/gpt-6.1-sol' } }).report.find((r) => r.name === 'reviewer').status, 'unsupported', 'no copy left: still reported');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Claude roster: an edited copy is kept and reported; a two-model role keeps its Claude copy', () => {
  const f = rosterFixture();
  try {
    f.run(CLAUDE_MODELS);
    const path = join(f.targetAgentsDir, 'reviewer.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nMy own note.\n`);
    const kept = f.run({ ...CLAUDE_MODELS, reviewer: { model: 'overpass/agentic-high' } }).report.find((r) => r.name === 'reviewer');
    assert.equal(kept.status, 'unsupported_but_modified');
    assert.equal(kept.refused, true);
    assert.match(kept.instruction, /no longer generated \(config\.models\.reviewer is overpass\/agentic-high/);
    assert.match(readFileSync(path, 'utf8'), /My own note\./);
    rmSync(path);
    f.run({ ...CLAUDE_MODELS, reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } });
    assert.match(readFileSync(path, 'utf8'), /^model: claude-opus-5-5$/m, 'the unresolved conflict keeps the Claude side');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ── custom agents ───────────────────────────────────────────────────────────

const KEY = 'custom-team-scout';
function customProject(src, entry) {
  const root = scratch('host-fit-custom-');
  mkdirSync(join(root, 'agent-sources'), { recursive: true });
  writeFileSync(join(root, 'agent-sources', `${KEY}.md`), src);
  return { root, config: { models: { [KEY]: entry } } };
}
const SRC = '---\nname: team-scout\ndescription: Scouts the team folders\ntools: Read, Grep\n---\nFind things.\n';

test('custom agent: a host that cannot run the model gets no copy; its unedited copy goes and an edited one stays', () => {
  const p = customProject(SRC, {});
  try {
    syncCustomAgents(p.root, p.config, { hosts: ['claude', 'opencode', 'agy'] });
    assert.doesNotMatch(readFileSync(join(p.root, '.claude/agents/team-scout.md'), 'utf8'), /^model:/m);
    assert.doesNotMatch(readFileSync(join(p.root, '.opencode/agents/team-scout.md'), 'utf8'), /^model:/m);
    assert.match(readFileSync(join(p.root, '.agents/agents/team-scout/agent.md'), 'utf8'), /^model: inherit$/m);
    const agyPath = join(p.root, '.agents/agents/team-scout/agent.md');
    writeFileSync(agyPath, `${readFileSync(agyPath, 'utf8')}edited\n`);
    const r = syncCustomAgents(p.root, { models: { [KEY]: { model: 'overpass/agentic-auto' }, }, overpass: { provider: 'gw' } }, { hosts: ['claude', 'opencode', 'agy'] });
    assert.deepEqual(r.removed, [{ key: KEY, host: 'claude', path: '.claude/agents/team-scout.md' }]);
    assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false);
    assert.match(readFileSync(join(p.root, '.opencode/agents/team-scout.md'), 'utf8'), /^model: gw\/agentic-auto$/m, 'OpenCode maps the tier through the provider');
    assert.ok(existsSync(agyPath), 'the edited agy copy is kept');
    assert.ok(r.refused.some((x) => x.host === 'claude' && /claude cannot run overpass\/agentic-auto/.test(x.reason)));
    assert.ok(r.refused.some((x) => x.host === 'agy' && /edited after Sterling wrote it.*kept and still installed/.test(x.reason)));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('custom agent: an agy-origin agent with mcpServers refuses Claude and OpenCode, keeps agy (board 83a09944)', () => {
  const src = '---\nsterling-origin: agy\nname: team-scout\ndescription: Scouts\ntools:\n  - view_file\nmcpServers:\n  - name: extra\n    command: node\n---\nFind things.\n';
  const p = customProject(src, {});
  try {
    const r = syncCustomAgents(p.root, p.config, { hosts: ['claude', 'opencode', 'agy'] });
    for (const host of ['claude', 'opencode']) {
      assert.ok(r.refused.some((x) => x.host === host && /cannot express the frontmatter key\(s\) mcpServers/.test(x.reason)), host);
      assert.equal(existsSync(join(p.root, host === 'claude' ? '.claude/agents/team-scout.md' : '.opencode/agents/team-scout.md')), false, host);
    }
    assert.match(readFileSync(join(p.root, '.agents/agents/team-scout/agent.md'), 'utf8'), /mcpServers:/);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('custom agent: a quoted "sterling-origin" key is Sterling bookkeeping and never rendered', () => {
  for (const quoted of ['"sterling-origin"', "'sterling-origin'"]) {
    const p = customProject(`---\n${quoted}: claude\nname: team-scout\ndescription: Scouts\ntools: Read\n---\nFind things.\n`, {});
    try {
      syncCustomAgents(p.root, p.config, { hosts: ['claude'] });
      assert.doesNotMatch(readFileSync(join(p.root, '.claude/agents/team-scout.md'), 'utf8'), /sterling-origin/, quoted);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test('custom agent: an Opus agent gets no agy copy, and the stale unedited agy copy is removed', () => {
  const p = customProject(SRC, {});
  try {
    syncCustomAgents(p.root, p.config, { hosts: ['claude', 'opencode', 'agy'] });
    const agyPath = join(p.root, '.agents/agents/team-scout/agent.md');
    assert.match(readFileSync(agyPath, 'utf8'), /^model: inherit$/m, 'no model: every host inherits');
    const r = syncCustomAgents(p.root, { models: { [KEY]: { model: 'anthropic/claude-opus-5-5', effort: 'high' } } }, { hosts: ['claude', 'opencode', 'agy'] });
    assert.deepEqual(r.removed, [{ key: KEY, host: 'agy', path: '.agents/agents/team-scout/agent.md' }]);
    assert.equal(existsSync(agyPath), false);
    assert.ok(r.refused.some((x) => x.host === 'agy' && /agy cannot run anthropic\/claude-opus-5-5/.test(x.reason)));
    assert.match(readFileSync(join(p.root, '.claude/agents/team-scout.md'), 'utf8'), /^model: claude-opus-5-5$/m);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('custom agent: an agy/flash agent gets an agy copy naming model: flash, and no Claude Code or OpenCode copy', () => {
  const p = customProject(SRC, { model: 'agy/flash' });
  try {
    const r = syncCustomAgents(p.root, p.config, { hosts: ['claude', 'opencode', 'agy'] });
    assert.match(readFileSync(join(p.root, '.agents/agents/team-scout/agent.md'), 'utf8'), /^model: flash$/m);
    assert.equal(existsSync(join(p.root, '.claude/agents/team-scout.md')), false);
    assert.equal(existsSync(join(p.root, '.opencode/agents/team-scout.md')), false);
    assert.ok(r.refused.some((x) => x.host === 'claude' && /claude cannot run agy\/flash/.test(x.reason)));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('agy roster through readAgyFit: an agy/flash role renders model: flash; Claude-model roles lose their unedited copies', () => {
  const projectDir = scratch('host-fit-agy-fit-');
  const pluginRoot = join(import.meta.dirname, '..', '..');
  try {
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    writeFileSync(join(projectDir, '.sterling', 'config.json'), JSON.stringify({ models: { scout: { model: 'agy/flash' } } }));
    const args = { projectDir, pluginRoot, root: pluginRoot, tracked: [], nodePath: '/usr/bin/node' };
    ensureAgyAgents(args);
    assert.ok(existsSync(join(projectDir, '.agents/agents/reviewer/agent.md')), 'a stale copy from before');
    const { unsupported, frozen, models } = readAgyFit(projectDir);
    assert.deepEqual(models, { scout: 'flash' });
    const rows = ensureAgyAgents({ ...args, agyModels: models, unsupported, frozen });
    assert.match(readFileSync(join(projectDir, '.agents/agents/scout/agent.md'), 'utf8'), /^model: flash$/m);
    assert.equal(rows.find((r) => r.item === '.agents/agents/reviewer/agent.md').status, 'removed');
    assert.equal(existsSync(join(projectDir, '.agents/agents/reviewer')), false, 'the Opus reviewer gets no agy copy');
    assert.ok(existsSync(join(projectDir, '.agents/agents/conductor/agent.md')), 'the conductor is not judged');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ── agy roster ──────────────────────────────────────────────────────────────

test('agy roster: a role agy cannot run loses its unedited copy; an edited one is kept and reported', () => {
  const projectDir = scratch('host-fit-agy-');
  const pluginRoot = join(import.meta.dirname, '..', '..');
  try {
    const args = { projectDir, pluginRoot, root: pluginRoot, tracked: [], nodePath: '/usr/bin/node' };
    ensureAgyAgents(args);
    const rel = '.agents/agents/librarian/agent.md';
    assert.ok(existsSync(join(projectDir, rel)));
    const why = 'agy cannot run anthropic/claude-haiku-5-5, so it gets no copy of librarian';
    const rows = ensureAgyAgents({ ...args, unsupported: new Map([['librarian', why]]) });
    assert.deepEqual(rows.find((r) => r.item === rel), { item: rel, status: 'removed', detail: `${why}; the unedited copy Sterling wrote is removed` });
    assert.equal(existsSync(join(projectDir, '.agents/agents/librarian')), false);
    ensureAgyAgents(args);
    writeFileSync(join(projectDir, rel), `${readFileSync(join(projectDir, rel), 'utf8')}edited\n`);
    const kept = ensureAgyAgents({ ...args, unsupported: new Map([['librarian', why]]) }).find((r) => r.item === rel);
    assert.equal(kept.status, 'refused');
    assert.match(kept.detail, /was edited after Sterling wrote it, so Sterling keeps it/);
    assert.ok(existsSync(join(projectDir, rel)));
    assert.equal(typeof renderAgyAgent, 'function');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ── maintenance worker ──────────────────────────────────────────────────────

test('maintenance worker: models["maintenance-worker"] is its one model; unset keeps the shipped pair', () => {
  assert.equal(workerModelOf({}), null);
  assert.deepEqual(workerModelOf({ models: { 'maintenance-worker': { model: 'claude-haiku-5-5' } } }), { model: 'anthropic/claude-haiku-5-5' });
  assert.match(workerModelOf({ models: { 'maintenance-worker': 'x' } }).error, /must be/);
  const args = (o) => buildWorkerArgs({ mcpConfig: '{}', agentDefinition: '{}', ...o });
  assert.deepEqual(args({}).slice(0, 5), ['-p', '--model', 'claude-sonnet-5-5', '--effort', 'medium']);
  assert.deepEqual(args({ model: 'claude-haiku-5-5' }).slice(0, 4), ['-p', '--model', 'claude-haiku-5-5', '--agents'], 'an unset effort is not sent');
});

test('Claude conductor: models.conductor pins its model and effort; a model Claude Code cannot run removes the unedited copy; none set renders the template as it is (item-G review finding 5)', () => {
  const dir = scratch('host-fit-conductor-');
  try {
    const templatesDir = join(dir, 'agent-templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'conductor.md'), `---\nname: conductor\ndescription: Conducts.\n---\n\nConductor body.\n`);
    const registryPath = join(templatesDir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'conductor', file: 'conductor.md' }] }));
    const targetAgentsDir = join(dir, '.claude', 'agents');
    const run = (models) => syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: '2026-01-01T00:00:00.000Z', config: { models } });
    const file = join(targetAgentsDir, 'conductor.md');
    run({});
    assert.doesNotMatch(readFileSync(file, 'utf8'), /^(model|effort):/m, 'no models.conductor: no pin');
    rmSync(file);
    run({ conductor: { model: 'anthropic/claude-opus-5-5', effort: 'high' } });
    assert.match(readFileSync(file, 'utf8'), /^---\nname: conductor\ndescription: Conducts\.\nmodel: claude-opus-5-5\neffort: high\n---\n/);
    const { report } = run({ conductor: { model: 'openai/gpt-6.1-sol', effort: 'high' } });
    assert.equal(existsSync(file), false, 'Sol on the conductor leaves no Claude copy');
    assert.deepEqual(report.find((r) => r.name === 'conductor'), { name: 'conductor', status: 'unsupported_removed', detail: 'config.models.conductor is openai/gpt-6.1-sol, which Claude Code cannot run (it runs anthropic models only)' });
    assert.equal(run({ conductor: { model: 'overpass/agentic-conductor' } }).report.find((r) => r.name === 'conductor').status, 'unsupported', 'a tier is not a Claude model either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
