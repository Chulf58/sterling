import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstalledAgent, loadRegistry } from '../lib/agent-distribution.mjs';
import {
  lintAgentPrompt,
  checkSpawnContract,
  collectAgentTemplates,
  lintSkill,
  collectSkills,
  lintToolGrants,
  readRegisteredToolNames,
  INHERIT_ALL_AGENTS,
} from '../lib/checks.mjs';
import { AGENT_MODEL_KEY } from '@sterling/schemas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TPL = join(root, 'agent-templates');
const VARS = { NODE: '"C:/tools with space/node.exe"', HOOKS_DIR: 'C:/plugin/hooks', GIT_RO: '/clone/scripts/git-ro.mjs' };
const OPTS = { pluginVersion: '0.1.0', now: '2026-06-10T12:00:00.000Z', vars: VARS };

// Phase 2 (r-ea9e): model:/effort: in the 9 templates are {{MODEL}}/{{EFFORT}}
// tokens, resolved at render time from config.models via AGENT_MODEL_KEY. Build a
// config covering every distinct config key so any agent renders. The interface
// slice does not fix the opts KEY the parsed config arrives on, so supply it under
// both plausible carriers (opts.config.models AND opts.models) — the behavior is
// the contract, not the wire-name.
const MODELS = Object.fromEntries(
  [...new Set(Object.values(AGENT_MODEL_KEY))].map((k) => [k, { model: 'claude-opus-4-8', effort: 'low' }])
);
const CFG = { config: { models: MODELS }, models: MODELS };

// The scale-down cut (decision sterling-claude-code-scale-down-boundary,
// 2ad87dd1) deleted 8 pipeline/debugger templates. Slice 5/8 (same decision,
// change 3) then reshaped the survivors to OpenSterling's roster shape:
// explorer -> scout, plus a new implementor. Decision
// conductor-instructions-via-main-session-agent-route-a (2026-09-22) then
// added conductor: a MAIN-SESSION agent, never dispatched, so it is
// registered like every other agent but exempt from the §7.3/§7.4/tool-grant
// linters (MAIN_SESSION_AGENTS in ../lib/checks.mjs) — the loop below still
// runs it through each linter and expects an empty (vacuous) result. The
// roster is now implementor/researcher/scout/librarian/conductor.
const ROSTER = ['implementor', 'researcher', 'scout', 'librarian', 'conductor'];

test('the §7.1 roster is registered, linter-complete, and spawn-contracted', () => {
  const registry = loadRegistry(join(TPL, 'registry.json'));
  assert.deepEqual(registry.agents.map((a) => a.name).sort(), [...ROSTER].sort());
  for (const t of collectAgentTemplates(TPL)) {
    assert.deepEqual(lintAgentPrompt(t.content, t.file), [], `${t.file} passes the §7.3 linter`);
    assert.deepEqual(checkSpawnContract(t.content, t.file), [], `${t.file} declares required_inputs`);
  }
});

// Tool-grant linter (board bc272f83). The two historical failures it exists to
// catch are asserted head-on: a single-prefix grant, and a store-tool grant with
// no ToolSearch. Both were SILENT in production — the platform ignores an
// unmounted tool name, so the agent simply lacked the tool.
test('tool-grant linter: the shipped roster is clean, and it catches every failure in the silent-name class', () => {
  const registeredTools = readRegisteredToolNames(join(root, 'packages', 'mcp-server', 'src', 'server.ts'));

  // the registered surface is derived from server.ts, not duplicated
  assert.ok(registeredTools.has('knowledge_query'), 'knowledge_query is a registered tool');
  assert.ok(!registeredTools.has('knowledge_frobnicate'), 'a made-up name is not registered');

  // every shipped template passes
  for (const t of collectAgentTemplates(TPL)) {
    assert.deepEqual(lintToolGrants(t.content, t.file, registeredTools), [], `${t.file} passes the tool-grant linter`);
  }

  const tpl = (tools) => `---\nname: probe\ntools: ${tools}\nrequired_inputs:\n  - x\n---\n\nbody\n`;
  const kinds = (tools) => lintToolGrants(tpl(tools), 'probe.md', registeredTools).map((v) => v.kind);

  // REGRESSION 1 — the 2026-07-20 defect: only the plugin prefix, dead under --strict-mcp-config
  assert.ok(
    kinds('Read, ToolSearch, mcp__plugin_sterling_sterling__knowledge_query').includes('missing_mcp_prefix'),
    'a single-prefix (plugin-only) grant is caught'
  );
  // ...and the mirror image: only the strict prefix, dead under --plugin-dir
  assert.ok(
    kinds('Read, ToolSearch, mcp__sterling__knowledge_query').includes('missing_mcp_prefix'),
    'a single-prefix (strict-only) grant is caught'
  );
  // REGRESSION 2 — store tools granted with no ToolSearch: present-but-uncallable
  assert.ok(
    kinds('Read, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query').includes('missing_toolsearch'),
    'a store-tool grant without ToolSearch is caught'
  );
  // a typo'd / retired tool name must not pass silently
  assert.ok(
    kinds('Read, ToolSearch, mcp__sterling__knowledge_qeury, mcp__plugin_sterling_sterling__knowledge_qeury').includes('unknown_mcp_tool'),
    'a misspelled tool name is caught'
  );
  // a foreign mcp prefix is not silently accepted as a Sterling grant
  assert.ok(
    kinds('Read, ToolSearch, mcp__someotherserver__knowledge_query').includes('unknown_mcp_prefix'),
    'a non-Sterling mcp prefix is caught'
  );
  // a correctly-formed dual-prefix grant is clean
  assert.deepEqual(
    kinds('Read, ToolSearch, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query'),
    [],
    'a correct dual-prefix grant passes'
  );
  // an agent granting NO store tools needs no ToolSearch
  assert.deepEqual(kinds('Read, Grep, Glob'), [], 'a store-free agent needs no ToolSearch');
});


test('templates render with install-time vars: model/effort resolved from config.models (§6)', () => {
  // NODE/HOOKS_DIR/GIT_RO hook-command substitution is untestable against a real
  // shipped template since the scale-down cut (decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1): the 4 surviving/added
  // templates (implementor, researcher, scout, librarian) carry NO hooks: block
  // and reference only {{MODEL}}/{{EFFORT}} — the old coder.md-pinned
  // hook-command literal this test used to check died with coder.md. What
  // survives to test here is the model/effort resolution path.
  const content = readFileSync(join(TPL, 'librarian.md'), 'utf8');
  const { installedContent } = renderInstalledAgent(content, 'librarian.md', { ...OPTS, ...CFG });
  assert.ok(!installedContent.includes('{{'), 'no tokens survive install (model/effort resolved)');
  const fm = installedContent.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^model: claude-opus-4-8$/m, 'MODEL token resolved from config.models');
  assert.match(fm, /^effort: low$/m, 'EFFORT token resolved from config.models');
});

test('full roster installs end-to-end through the CLI with detected vars; model/effort tokens resolve to concrete pinned ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-roster-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'install-agents.mjs'), '--target', dir], {
      encoding: 'utf8',
      cwd: root,
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const installed = readdirSync(join(dir, '.claude', 'agents')).sort();
    assert.deepEqual(installed, ROSTER.map((n) => `${n}.md`).sort());
    assert.match(r.stdout, /RESTART REQUIRED/);
    const librarian = readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8');
    assert.match(librarian, /sterling-generated v=/);
    // No hooks: block survives in any of the 4 shipped templates (scale-down
    // decision sterling-claude-code-scale-down-boundary, 2ad87dd1) — HOOKS_DIR/NODE
    // baking is no longer exercised by a real shipped template; see the render test
    // above for what still is (model/effort resolution).
    assert.ok(!librarian.includes('{{'), 'no substitution token survives the CLI install');
    const fm = librarian.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, 'model resolved to a concrete pinned claude- id');
    assert.match(fm, /^effort: [a-z]+$/m, 'effort resolved to a concrete value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('skills ship with live file references and pass the skill linter', () => {
  const skills = collectSkills(join(root, 'skills'));
  assert.deepEqual(skills.map((s) => s.file).sort(), [
    'cleanup/SKILL.md',
    'closing-out-tasks/SKILL.md',
    'debug/SKILL.md',
    'decision-records/SKILL.md',
    'delegating-to-subagents/SKILL.md',
    'design-research/SKILL.md',
    'drain/SKILL.md',
    'review-brief/SKILL.md',
  ]);
  for (const s of skills) assert.deepEqual(lintSkill(s.content, s.file, root), []);
  assert.ok(existsSync(join(root, 'skills', 'debug', 'SKILL.md')));
});

// ---------------------------------------------------------------------------
// AC6 (run r-d630 phase 3) — every reviewer template carries a worked handoff
// example with the exact required arrays plus a dispositions example (both verbs).
// Templates are read at TEST RUNTIME (never copied into a fixture) so the assertion
// tracks the shipped file. The existing linter test above keeps dead-term + prompt
// -section linters green across all templates.
// ---------------------------------------------------------------------------

// Inherit-all implementor (decision
// implementor-inherits-all-tools-read-only-agents-keep-allowlists, bc1894e5):
// the implementor drops its tools: allowlist so it inherits every session tool
// (every project MCP server, both Sterling prefixes, ToolSearch) and declares a
// disallowedTools deny-list instead. The marker is the frontmatter itself: a
// template with disallowedTools: and no tools: is inherit-all. The allowlist
// agents (researcher, scout, librarian) must still carry tools:.
const STORE_WRITE_TOOLS = [
  'knowledge_create', 'knowledge_split', 'knowledge_extract', 'knowledge_retire', 'knowledge_supersede',
  'knowledge_update', 'knowledge_append', 'knowledge_edit', 'knowledge_array_remove', 'knowledge_promote',
  'knowledge_link', 'board_add', 'board_remove', 'board_update', 'board_edit', 'maintenance_remove',
  'config_set', 'no_capture', 'concept_designed', 'capture_pending',
];
// Every registered Sterling tool is classified READ or WRITE, so a newly
// registered tool cannot slip past the implementor's deny-list unclassified.
const STORE_READ_TOOLS = [
  'knowledge_query', 'knowledge_get', 'knowledge_render', 'knowledge_schema', 'knowledge_stats',
  'knowledge_preflight', 'board_query', 'board_get', 'maintenance_query',
];

test('every registered Sterling tool is classified READ or WRITE — exactly, no overlap, no gap', () => {
  const registered = readRegisteredToolNames(join(root, 'packages', 'mcp-server', 'src', 'server.ts'));
  const classified = [...STORE_READ_TOOLS, ...STORE_WRITE_TOOLS];
  assert.equal(new Set(classified).size, classified.length, 'no tool is both READ and WRITE');
  assert.deepEqual([...classified].sort(), [...registered].sort(), 'classify a newly registered tool in STORE_READ_TOOLS or STORE_WRITE_TOOLS (and the implementor deny-list)');
});

const fmOf = (content) => content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];

test('inherit-all implementor: no tools: line; disallowedTools denies exactly the Sterling store-write tools under both prefixes', () => {
  const impl = readFileSync(join(TPL, 'implementor.md'), 'utf8');
  assert.doesNotMatch(fmOf(impl), /^tools:/m, 'the implementor inherits every session tool (bc1894e5)');
  const line = fmOf(impl).match(/^disallowedTools:\s*(.+)$/m);
  assert.ok(line, 'the implementor declares a disallowedTools deny-list');
  const denied = line[1].split(',').map((t) => t.trim());
  const expected = STORE_WRITE_TOOLS.flatMap((t) => ['mcp__sterling__' + t, 'mcp__plugin_sterling_sterling__' + t]);
  assert.deepEqual([...denied].sort(), [...expected].sort(), 'store writes are the conductor\'s (the implementor role contract) — nothing more is denied');
  for (const read of ['knowledge_query', 'knowledge_get', 'board_query', 'board_get', 'knowledge_preflight']) {
    assert.ok(!denied.some((d) => d.endsWith('__' + read)), `${read} stays inherited`);
  }
});

test('the allowlist agents keep their tools: line (a read-only agent must not silently gain an MCP writer)', () => {
  for (const file of ['researcher.md', 'scout.md', 'librarian.md']) {
    assert.match(fmOf(readFileSync(join(TPL, file), 'utf8')), /^tools:/m, `${file} keeps its allowlist`);
  }
});

test('tool-grant linter: inherit-all (disallowedTools, no tools:) passes; a template with neither still fails; deny entries are linted like grants', () => {
  const registeredTools = readRegisteredToolNames(join(root, 'packages', 'mcp-server', 'src', 'server.ts'));
  const tpl = (fmLine) => `---\nname: probe\n${fmLine}required_inputs:\n  - x\n---\n\nbody\n`;
  // labelled implementor.md: inherit-all is reserved to INHERIT_ALL_AGENTS (review LOW 2)
  const kinds = (fmLine) => lintToolGrants(tpl(fmLine), 'implementor.md', registeredTools).map((v) => v.kind);
  assert.deepEqual(kinds('disallowedTools: mcp__sterling__board_add, mcp__plugin_sterling_sterling__board_add\n'), [], 'a well-formed inherit-all deny-list passes');
  assert.deepEqual(kinds(''), ['missing_tools_line'], 'no tools: and no disallowedTools: is still a missing allowlist');
  assert.ok(kinds('disallowedTools: mcp__sterling__board_add\n').includes('missing_mcp_prefix'), 'a single-prefix deny is dead under the other launcher');
  assert.ok(kinds('disallowedTools: mcp__sterling__board_ad, mcp__plugin_sterling_sterling__board_ad\n').includes('unknown_mcp_tool'), 'a misspelled deny is caught');
  assert.ok(kinds('disallowedTools: mcp__other__x\n').includes('unknown_mcp_prefix'), 'a foreign mcp deny is not silently accepted');
});

test('tool-grant linter: inherit-all is allowed only for INHERIT_ALL_AGENTS — any other template with disallowedTools and no tools: fails', () => {
  const registeredTools = readRegisteredToolNames(join(root, 'packages', 'mcp-server', 'src', 'server.ts'));
  const body = `---\nname: probe\ndisallowedTools: mcp__sterling__board_add, mcp__plugin_sterling_sterling__board_add\nrequired_inputs:\n  - x\n---\n\nbody\n`;
  assert.deepEqual(INHERIT_ALL_AGENTS, ['implementor.md']);
  assert.deepEqual(lintToolGrants(body, 'implementor.md', registeredTools), []);
  for (const label of ['scout.md', 'researcher.md', 'librarian.md', 'probe.md']) {
    assert.deepEqual(lintToolGrants(body, label, registeredTools).map((v) => v.kind), ['inherit_all_not_allowed'], `${label} may not inherit every tool`);
  }
});
