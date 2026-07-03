import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderInstalledAgent,
  parseInstalledHeader,
  isLocallyModified,
  installAgents,
  syncAgents,
  setInstalledModelEffort,
  checkAgentsVisible,
  checkRegistryConsistency,
  findDeadTerms,
  findBackslashHookCommands,
  sha256,
  RESTART_INSTRUCTION,
} from '../lib/agent-distribution.mjs';
import { AGENT_MODEL_KEY } from '@sterling/schemas';

const TEMPLATE = `---
name: probe-agent
description: Fixture agent for distribution tests.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'
---

Fixture body line one.
`;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const OPTS = { pluginVersion: '0.1.0', now: T0 };

// -----------------------------------------------------------------------------
// Phase-2 (r-ea9e) fixtures: config.models resolution + surgical model/effort swap.
//
// config.models is threaded into render/install/sync as "the parsed config"
// (design 98064d77 §a: "resolved at render time from config.models via
// AGENT_MODEL_KEY"; the phase goal: "init/sync pass the parsed config through").
// The interface slice names the FUNCTIONS and the resolution SOURCE (config.models
// via AGENT_MODEL_KEY) but not the literal opts KEY the parsed config arrives on.
// Rather than pin a wire-name the design does not fix, these tests supply the
// config under BOTH plausible carriers (opts.config.models AND opts.models) — the
// behavior asserted is the contract (tokens resolve from config.models per the
// map); whichever field the implementation reads, the same values resolve.
const cfgBoth = (models) => ({ config: { models }, models });

// A tokenized template for a REAL registered agent (so AGENT_MODEL_KEY resolves).
// model:/effort: are substitution tokens per design 98064d77 §a.
const CODER_TOKEN_TEMPLATE = `---
name: coder
description: Tokenized fixture for model/effort resolution.
tools: Read
model: {{MODEL}}
effort: {{EFFORT}}
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'
---

Coder fixture body one.
`;

// A template carrying LITERAL model:/effort: frontmatter lines AND body lines that
// merely start with "model:"/"effort:" — the frontmatter-scoping boundary for the
// surgical swap (a naive global rewrite would corrupt the body lines).
const SWAP_TEMPLATE = `---
name: probe-agent
description: Fixture agent for the surgical swap test.
tools: Read
model: claude-sonnet-4-6
effort: medium
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'
---

Fixture body.
model: this-line-is-body-not-frontmatter
effort: also-body
`;

const frontmatter = (s) => s.match(/^---\n([\s\S]*?)\n---/)[1];

function scratch() {
  return mkdtempSync(join(tmpdir(), 'sterling-dist-test-'));
}

function makePluginSide(dir, templates) {
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  const agents = [];
  for (const [file, content] of Object.entries(templates)) {
    writeFileSync(join(templatesDir, file), content);
    const name = content.match(/^name:\s*(\S+)/m)[1];
    agents.push({ name, file });
  }
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents }, null, 2));
  return { templatesDir, registryPath };
}

test('renderInstalledAgent produces a parseable header and intact content hash', () => {
  const { name, installedContent } = renderInstalledAgent(TEMPLATE, 'probe-agent.md', OPTS);
  assert.equal(name, 'probe-agent');
  const header = parseInstalledHeader(installedContent);
  assert.ok(header, 'header must parse');
  assert.equal(header.pluginVersion, '0.1.0');
  assert.equal(header.template, 'probe-agent');
  assert.equal(header.templateHash, sha256(TEMPLATE));
  assert.equal(header.installedAt, T0);
  assert.equal(isLocallyModified(installedContent, header), false);
  assert.match(installedContent, /^---\n/, 'frontmatter must stay first for the platform');
  assert.ok(installedContent.includes('Fixture body line one.'));
});

test('renderInstalledAgent refuses backslash hook commands (spec §6 emission rule)', () => {
  const bad = TEMPLATE.replace('"C:/proj/hooks/h.mjs"', '"C:\\\\proj\\\\hooks\\\\h.mjs"');
  assert.ok(findBackslashHookCommands(bad.match(/^---\n([\s\S]*?)\n---/)[1]).length > 0);
  assert.throws(() => renderInstalledAgent(bad, 'bad.md', OPTS), /backslash check failed/);
});

test('renderInstalledAgent refuses dead terms in template content', () => {
  const bad = TEMPLATE.replace('Fixture body line one.', 'Inherited from Forge waves.');
  assert.ok(findDeadTerms(bad).length >= 2);
  assert.throws(() => renderInstalledAgent(bad, 'bad.md', OPTS), /dead-term check failed/);
});

test('isLocallyModified detects edits and tolerates CRLF churn', () => {
  const { installedContent } = renderInstalledAgent(TEMPLATE, 'probe-agent.md', OPTS);
  const header = parseInstalledHeader(installedContent);
  assert.equal(isLocallyModified(installedContent.replace(/\n/g, '\r\n'), parseInstalledHeader(installedContent.replace(/\n/g, '\r\n'))), false, 'CRLF conversion is not a modification');
  const edited = installedContent.replace('Fixture body line one.', 'Locally tweaked.');
  assert.equal(isLocallyModified(edited, header), true);
});

test('installAgents installs every registered agent and returns the restart instruction', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const { report, restartInstruction } = installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(report, [{ name: 'probe-agent', status: 'installed' }]);
    assert.equal(restartInstruction, RESTART_INSTRUCTION);
    assert.match(restartInstruction, /RESTART REQUIRED/);
    const installed = readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8');
    assert.ok(parseInstalledHeader(installed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installAgents throws on registry/template name mismatch', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'other-name', file: 'probe-agent.md' }] }));
    assert.throws(
      () => installAgents({ templatesDir, registryPath, targetAgentsDir: join(dir, 'p', '.claude', 'agents'), ...OPTS }),
      /name mismatch/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents covers every status path', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');

    // missing -> installed
    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(r.report.map((x) => x.status), ['installed']);

    // unchanged -> up_to_date
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(r.report.map((x) => x.status), ['up_to_date']);

    // template changed, install clean -> refreshed (header re-rendered)
    const v2 = TEMPLATE.replace('line one', 'line one v2');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v2);
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['refreshed']);
    const refreshed = readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8');
    assert.ok(refreshed.includes('line one v2'));
    assert.equal(parseInstalledHeader(refreshed).pluginVersion, '0.2.0');

    // locally modified + template unchanged -> noted, untouched
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, refreshed.replace('line one v2', 'local tweak'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['locally_modified_up_to_date']);

    // locally modified + template changed -> refused, file untouched, instruction present
    const v3 = v2.replace('line one v2', 'line one v3');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v3);
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.match(r.report[0].instruction, /will not overwrite local changes/);
    assert.ok(readFileSync(installedPath, 'utf8').includes('local tweak'), 'refused file must be untouched');

    // file without a sterling header -> foreign_file, untouched
    writeFileSync(installedPath, '---\nname: probe-agent\n---\nhand-written\n');
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'foreign_file');
    assert.ok(readFileSync(installedPath, 'utf8').includes('hand-written'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents repairs header-only drift (in-place edit mirrored in the template) instead of refusing', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });

    // The pinning incident: the same edit lands in the template AND in the
    // installed copy, but the installed header keeps the old hashes.
    const pinned = TEMPLATE.replace('tools: Read', 'tools: Read\nmodel: claude-sonnet-4-6');
    writeFileSync(join(templatesDir, 'probe-agent.md'), pinned);
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('tools: Read', 'tools: Read\nmodel: claude-sonnet-4-6'));

    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report, [{ name: 'probe-agent', status: 'header_repaired' }]);
    const repaired = readFileSync(installedPath, 'utf8');
    assert.ok(repaired.includes('model: claude-sonnet-4-6'), 'edited content survives the repair');
    const header = parseInstalledHeader(repaired);
    assert.equal(header.templateHash, sha256(pinned), 'header now records the current template');
    assert.equal(isLocallyModified(repaired, header), false, 'content hash is consistent again');
    assert.equal(header.installedAt, T1, 'repair re-stamps installed_at (restart semantics)');

    // converged: the next sync is a no-op
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['up_to_date']);

    // genuine divergence on a changed template still refuses, file untouched
    writeFileSync(installedPath, repaired.replace('Fixture body line one.', 'a real local edit'));
    writeFileSync(join(templatesDir, 'probe-agent.md'), pinned.replace('line one', 'line one v2'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.ok(readFileSync(installedPath, 'utf8').includes('a real local edit'), 'refused file must be untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents never repairs across a machine-var difference (frontmatter divergence refuses)', () => {
  const dir = scratch();
  try {
    const VAR_TEMPLATE = TEMPLATE.replace('"C:/tools/node.exe"', '{{NODE}}');
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': VAR_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: { NODE: '"/usr/bin/node"' } });

    // Header-only drift is forged exactly as in the repair test — but the
    // machine changed: the fresh render bakes a different NODE into the
    // frontmatter, so the bodies differ and repair must NOT fire.
    const v2 = VAR_TEMPLATE.replace('line one', 'line one v2');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v2);
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('line one', 'line one v2'));

    const r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, vars: { NODE: '"C:/other/node.exe"' } });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.ok(readFileSync(installedPath, 'utf8').includes('/usr/bin/node'), 'file untouched — the other machine’s baked paths preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAgentsVisible: ok / missing_agent / restart_required / missing_generated_header', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');

    // not installed yet
    let v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.equal(v.visible, false);
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'missing_agent' }]);

    // installed at T0, session started T1 (after) -> visible
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.deepEqual(v, { visible: true, problems: [] });

    // session started before install -> restart_required
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: '2025-12-31T00:00:00.000Z' });
    assert.equal(v.visible, false);
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'restart_required' }]);

    // header stripped -> missing_generated_header
    const p = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/<!-- sterling-generated [^\n]*-->\n/, ''));
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'missing_generated_header' }]);

    assert.throws(() => checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: 'not-a-date' }), /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkRegistryConsistency: pass and each violation kind', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    assert.deepEqual(checkRegistryConsistency({ templatesDir, registryPath }), []);

    // unregistered template
    writeFileSync(join(templatesDir, 'stray.md'), TEMPLATE.replace('probe-agent', 'stray'));
    let v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['unregistered_template']);
    rmSync(join(templatesDir, 'stray.md'));

    // missing template file
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }, { name: 'ghost', file: 'ghost.md' }] }));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['missing_template_file']);

    // name mismatch
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'wrong-name', file: 'probe-agent.md' }] }));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['name_mismatch']);

    // backslash hook command in a template
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }] }));
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('"C:/proj/hooks/h.mjs"', '"C:\\\\proj\\\\hooks\\\\h.mjs"'));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['backslash_hook_command']);
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE);

    // dead term in template body and in a scanned dir
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('Fixture body', 'Forge fixture body'));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['dead_term']);
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE);

    const scanDir = join(dir, 'scaffolds');
    mkdirSync(scanDir);
    writeFileSync(join(scanDir, 'note.md'), 'leftover brainstormer text');
    v = checkRegistryConsistency({ templatesDir, registryPath, scanDirs: [scanDir] });
    assert.deepEqual(v.map((x) => x.kind), ['dead_term']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-term patterns match the canonical kill list and nothing legitimate', () => {
  assert.equal(findDeadTerms('Quartermaine called a wave of brainstormers from the forge').length, 4);
  assert.equal(findDeadTerms('Sterling phase execution; intake; steps; wavelength; forget').length, 0);
});

// =============================================================================
// Phase 2 (r-ea9e) — config.models render substitution + surgical model/effort
// swap. AC6: after a TUI swap, a later agent-template update still flows through
// sync-agents — the swap must not trip the local-modification hash refusal.
// Governing: design 98064d77, header_repaired 6d5935d3, machine boundary d53dc92c.
// =============================================================================

test('phase-2 floor: a token-free template still renders WITHOUT config — model resolution is token-gated (regression floor for the probe-agent suite)', () => {
  // The existing probe-agent tests above pass NO config; adding config-driven
  // {{MODEL}}/{{EFFORT}} resolution must not make config mandatory for a template
  // that carries no such token. Render is identical with or without config.
  const a = renderInstalledAgent(TEMPLATE, 'probe-agent.md', OPTS).installedContent;
  const b = renderInstalledAgent(TEMPLATE, 'probe-agent.md', { ...OPTS, ...cfgBoth({ coder: { model: 'claude-opus-4-8', effort: 'high' } }) }).installedContent;
  assert.equal(a, b, 'a token-free template is byte-identical whether or not config.models is supplied');
});

test('renderInstalledAgent resolves {{MODEL}}/{{EFFORT}} per agent from config.models via AGENT_MODEL_KEY; template_hash stays token-form, content_hash includes substituted values', () => {
  const coderKey = AGENT_MODEL_KEY['coder'];
  assert.ok(coderKey, 'coder is a registered agent with an AGENT_MODEL_KEY entry');

  const opusModels = { [coderKey]: { model: 'claude-opus-4-8', effort: 'high' } };
  const { name, installedContent } = renderInstalledAgent(CODER_TOKEN_TEMPLATE, 'coder.md', { ...OPTS, ...cfgBoth(opusModels) });
  assert.equal(name, 'coder');

  // tokens resolved from config.models[AGENT_MODEL_KEY['coder']]
  assert.match(frontmatter(installedContent), /^model: claude-opus-4-8$/m, 'MODEL resolved from config.models');
  assert.match(frontmatter(installedContent), /^effort: high$/m, 'EFFORT resolved from config.models');
  assert.ok(!installedContent.includes('{{'), 'no substitution token survives');

  const header = parseInstalledHeader(installedContent);
  // template_hash stays token-form: over the ORIGINAL token template, model-independent.
  assert.equal(header.templateHash, sha256(CODER_TOKEN_TEMPLATE), 'template_hash is over the token-form template');
  // content_hash includes substituted values: the self-check passes only if the
  // header hash was computed over the SUBSTITUTED body (not the token form).
  assert.equal(isLocallyModified(installedContent, header), false, 'content_hash covers the substituted values (self-consistent)');

  // Rendering the SAME template with a DIFFERENT model keeps the token-form
  // template_hash but changes the body — proving content_hash tracks the values.
  const sonnetModels = { [coderKey]: { model: 'claude-sonnet-4-6', effort: 'low' } };
  const other = renderInstalledAgent(CODER_TOKEN_TEMPLATE, 'coder.md', { ...OPTS, ...cfgBoth(sonnetModels) }).installedContent;
  assert.equal(parseInstalledHeader(other).templateHash, sha256(CODER_TOKEN_TEMPLATE), 'template_hash is independent of the model chosen');
  assert.match(frontmatter(other), /^model: claude-sonnet-4-6$/m);
  assert.notEqual(other, installedContent, 'a different model yields different installed bytes');
  assert.equal(isLocallyModified(other, header), true, 'content_hash is value-sensitive: sonnet body reads as modified against the opus header');

  // reviewers many-to-one: reviewer-correctness resolves via the shared 'reviewers'
  // config key (AGENT_MODEL_KEY maps four reviewer agents to one key).
  assert.equal(
    AGENT_MODEL_KEY['reviewer-correctness'],
    AGENT_MODEL_KEY['reviewer-security'],
    'the reviewer agents share one config.models key (AGENT_MODEL_KEY many-to-one)'
  );
  const revKey = AGENT_MODEL_KEY['reviewer-correctness'];
  const revTemplate = CODER_TOKEN_TEMPLATE.replace('name: coder', 'name: reviewer-correctness');
  const revModels = { [revKey]: { model: 'claude-opus-4-8', effort: 'low' } };
  const rev = renderInstalledAgent(revTemplate, 'reviewer-correctness.md', { ...OPTS, ...cfgBoth(revModels) }).installedContent;
  assert.match(frontmatter(rev), /^model: claude-opus-4-8$/m, 'reviewer-correctness resolves via the shared reviewers key');
});

test('setInstalledModelEffort surgically rewrites ONLY the frontmatter model:/effort: lines, re-stamps content_hash, and leaves machine vars byte-identical', () => {
  // A properly generated installed file (literal model/effort lines; body lines
  // that merely start with model:/effort: are the frontmatter-scoping trap).
  const { installedContent: original } = renderInstalledAgent(SWAP_TEMPLATE, 'probe-agent.md', OPTS);
  const beforeHeader = parseInstalledHeader(original);
  assert.equal(isLocallyModified(original, beforeHeader), false, 'precondition: freshly rendered install is self-consistent');
  assert.match(frontmatter(original), /^model: claude-sonnet-4-6$/m, 'precondition: frontmatter starts on sonnet');

  const swapped = setInstalledModelEffort(original, { model: 'claude-opus-4-8', effort: 'high', pluginVersion: '0.1.0', now: T1 });

  // (1) the frontmatter model:/effort: lines are rewritten to the new values
  assert.match(frontmatter(swapped), /^model: claude-opus-4-8$/m, 'frontmatter model rewritten');
  assert.match(frontmatter(swapped), /^effort: high$/m, 'frontmatter effort rewritten');
  assert.ok(!frontmatter(swapped).includes('claude-sonnet-4-6'), 'the old frontmatter model is gone');
  assert.equal(swapped.split('\n').filter((l) => l === 'model: claude-opus-4-8').length, 1, 'exactly one model line — no duplication');
  assert.equal(swapped.split('\n').filter((l) => l === 'effort: high').length, 1, 'exactly one effort line — no duplication');

  // (2) frontmatter-SCOPED: body lines that start with model:/effort: are untouched
  assert.ok(swapped.includes('model: this-line-is-body-not-frontmatter'), 'a body line starting with model: is NOT rewritten');
  assert.ok(swapped.includes('effort: also-body'), 'a body line starting with effort: is NOT rewritten');

  // (3) machine vars (NODE/HOOKS_DIR baked into the hook command) are byte-identical
  assert.ok(swapped.includes('"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'), 'the baked hook command (machine vars) is byte-identical — a swap can never flip the WSL↔Windows boundary');

  // (4) ONLY the model:/effort: lines and the generated header line changed;
  //     every other byte (name, description, tools, hooks, body) is identical.
  const strip = (s) =>
    s.split('\n').filter((l) => !/^model:/.test(l) && !/^effort:/.test(l) && !/<!-- sterling-generated /.test(l));
  assert.deepEqual(strip(swapped), strip(original), 'every line except model:/effort:/header is byte-identical');

  // (5) the generated header content_hash is re-stamped so the swap is NOT read as
  //     a local modification — this is the crux of AC6.
  const afterHeader = parseInstalledHeader(swapped);
  assert.ok(afterHeader, 'header still parses after the swap');
  assert.equal(isLocallyModified(swapped, afterHeader), false, 're-stamped content_hash is consistent with the swapped body');
  assert.equal(afterHeader.templateHash, beforeHeader.templateHash, 'template_hash is unchanged — a swap does not change template identity');
  assert.equal(afterHeader.pluginVersion, '0.1.0', 'header carries the supplied pluginVersion');
  assert.equal(afterHeader.installedAt, T1, 'installed_at re-stamped to now — a swap needs a restart to govern dispatch (restart/visibility semantics, cf. header_repaired 6d5935d3)');
});

test('AC6: after a TUI swap the installed file is not locally-modified, and a later template update flows through syncAgents WITHOUT tripping the refusal', () => {
  const dir = scratch();
  try {
    const coderKey = AGENT_MODEL_KEY['coder'];
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const installedPath = join(targetAgentsDir, 'coder.md');

    // install with the initial pinned model
    const modelsA = { [coderKey]: { model: 'claude-sonnet-4-6', effort: 'low' } };
    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...cfgBoth(modelsA) });
    assert.deepEqual(r.report.map((x) => x.status), ['installed']);
    let installed = readFileSync(installedPath, 'utf8');
    assert.match(frontmatter(installed), /^model: claude-sonnet-4-6$/m, 'installed on the initial model');
    assert.ok(!installed.includes('{{'), 'tokens resolved at install');

    // TUI swap (AC2 dual write, mirrored here): the surgical helper rewrites the
    // installed frontmatter AND config.models is updated to the new pin.
    const modelsB = { [coderKey]: { model: 'claude-opus-4-8', effort: 'high' } };
    const swapped = setInstalledModelEffort(installed, { model: 'claude-opus-4-8', effort: 'high', pluginVersion: '0.1.0', now: T1 });
    writeFileSync(installedPath, swapped);
    assert.equal(isLocallyModified(swapped, parseInstalledHeader(swapped)), false, 'the swap leaves the file self-consistent — not locally modified');

    // a later agent-template update (body change) arrives; sync runs with the
    // updated config.models (authoritative). The swap must NOT be read as a local
    // modification, so this is a clean refresh — never refused_local_modification.
    writeFileSync(join(templatesDir, 'coder.md'), CODER_TOKEN_TEMPLATE.replace('Coder fixture body one.', 'Coder fixture body TWO.'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, ...cfgBoth(modelsB) });
    assert.notEqual(r.report[0].status, 'refused_local_modification', 'AC6: the swap must not trip the local-modification refusal');
    assert.ok(['refreshed', 'header_repaired', 'up_to_date'].includes(r.report[0].status), `a template update flows through cleanly (got ${r.report[0].status})`);

    const after = readFileSync(installedPath, 'utf8');
    assert.ok(after.includes('Coder fixture body TWO.'), 'the template update landed');
    assert.match(frontmatter(after), /^model: claude-opus-4-8$/m, 'the swapped model survived — config.models is authoritative');
    assert.ok(!after.includes('{{'), 'no token survives the refresh');
    assert.equal(isLocallyModified(after, parseInstalledHeader(after)), false, 'the refreshed file is self-consistent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a config MODEL divergence is never silently repaired — like the machine-var boundary, a forged header-only drift over a different config model still refuses', () => {
  // Parallels the machine-var refusal (d53dc92c): the header_repaired equivalence
  // check (6d5935d3) re-renders with THIS invocation's config, so if config.models
  // now names a different model than the installed frontmatter, the fresh body
  // differs and the divergence must REFUSE — never read as a repairable stale header.
  const dir = scratch();
  try {
    const coderKey = AGENT_MODEL_KEY['coder'];
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const installedPath = join(targetAgentsDir, 'coder.md');

    const modelsA = { [coderKey]: { model: 'claude-sonnet-4-6', effort: 'low' } };
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...cfgBoth(modelsA) });

    // forge header-only drift: mirror a body edit into template AND installed, but
    // leave the installed frontmatter on model A while config now names model B.
    const v2 = CODER_TOKEN_TEMPLATE.replace('Coder fixture body one.', 'Coder fixture body two.');
    writeFileSync(join(templatesDir, 'coder.md'), v2);
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('Coder fixture body one.', 'Coder fixture body two.'));

    const modelsB = { [coderKey]: { model: 'claude-opus-4-8', effort: 'high' } };
    const r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, ...cfgBoth(modelsB) });
    assert.equal(r.report[0].status, 'refused_local_modification', 'a config-model divergence is a genuine divergence — refuses, never header_repaired');
    assert.match(frontmatter(readFileSync(installedPath, 'utf8')), /^model: claude-sonnet-4-6$/m, 'refused file untouched — the installed model is preserved, not silently flipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
