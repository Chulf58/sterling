import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
  findDeadTermsStrict,
  STRICT_DEAD_TERM_PATTERNS,
  findBackslashHookCommands,
  extractHookCommandLines,
  extractBakedCommandPaths,
  sha256,
  RESTART_INSTRUCTION,
  ensureConductorActivation,
  describeConfigDrift,
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
// 'librarian', not 'coder': coder.md was deleted and dropped from
// AGENT_MODEL_KEY with the scale-down cut (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1) — librarian is a
// surviving roster agent, so AGENT_MODEL_KEY['librarian'] still resolves.
const CODER_TOKEN_TEMPLATE = `---
name: librarian
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
    assert.equal(r.report[0].refused, true, 'sync must flag the refusal so sync-agents exits 2 (same as install)');
    assert.match(r.report[0].instruction, /will not overwrite local changes/);
    assert.ok(readFileSync(installedPath, 'utf8').includes('local tweak'), 'refused file must be untouched');

    // file without a sterling header -> foreign_file, untouched
    writeFileSync(installedPath, '---\nname: probe-agent\n---\nhand-written\n');
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'foreign_file');
    assert.equal(r.report[0].refused, true, 'sync must flag the refusal so sync-agents exits 2 (same as install)');
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
// STRICT dead-term scan (board 481c9ec3): the relaxed, case-insensitive
// \bforge\b / \bwave\b check false-positives on ordinary English verbs
// ('forge an id', 'a wave of calls') once the scan widens to source dirs. The
// STRICT scan (STRICT_DEAD_TERM_PATTERNS / findDeadTermsStrict, wired into
// checkRegistryConsistency via a new codeScanDirs param) fixes this by
// requiring a case-sensitive, standalone-capitalized 'Forge' token and
// deliberately DROPPING 'wave' from the source-scan list entirely, while
// keeping Quatermain / brainstormer as codename residue.
// =============================================================================

test('findDeadTermsStrict: does NOT flag ordinary English "forge"/"wave" prose (the measured false positive, board 481c9ec3)', () => {
  const prose = 'forge an id for the request, then send a wave of calls';
  assert.deepEqual(findDeadTermsStrict(prose), [], 'lowercase English "forge" and "wave" are not codename hits under the strict scan');
});

test('findDeadTermsStrict: flags standalone capitalized "Forge", "Quatermain", "brainstormer" — naming each term', () => {
  const content = 'Inherited from Forge. Ask Quatermain about the old brainstormer flow.';
  const hits = findDeadTermsStrict(content);
  assert.ok(hits.length >= 3, `expected at least 3 hits (Forge, Quatermain, brainstormer), got ${JSON.stringify(hits)}`);
  const hitText = JSON.stringify(hits);
  assert.match(hitText, /Forge/, 'hit set names Forge');
  assert.match(hitText, /Quatermain/, 'hit set names Quatermain');
  assert.match(hitText, /brainstormer/, 'hit set names brainstormer');
});

test('checkRegistryConsistency: codeScanDirs runs the STRICT scan over source dirs — planted capitalized "Forge" fails naming the violation; ordinary "forge"/"wave" prose passes', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const codeDir = join(dir, 'src-fixture');
    mkdirSync(codeDir, { recursive: true });

    // Control arm, placed first: genuinely boring content (no dead terms of any
    // kind) must PASS. This rules out "codeScanDirs denies everything" as the
    // cause of any later failure — a pass path must exist before a fail means
    // anything.
    writeFileSync(join(codeDir, 'note.ts'), '// nothing interesting here at all');
    let v = checkRegistryConsistency({ templatesDir, registryPath, codeScanDirs: [codeDir] });
    assert.deepEqual(v, [], 'control: ordinary content with no dead terms passes');

    // Positive: a planted capitalized "Forge" token in the scanned source dir
    // must fail, naming the offending term.
    writeFileSync(join(codeDir, 'note.ts'), '// Inherited from Forge legacy naming');
    v = checkRegistryConsistency({ templatesDir, registryPath, codeScanDirs: [codeDir] });
    assert.ok(v.length > 0, 'a planted capitalized Forge token in a codeScanDirs source file must be flagged');
    assert.match(JSON.stringify(v), /Forge/, 'the violation names the offending term');

    // Negative: the same fixture holding only ordinary English "forge an id" /
    // "wave of retries" prose must pass — pins that the LOOP runs the STRICT
    // patterns (case-sensitive, no bare "wave"), not the relaxed ones.
    writeFileSync(join(codeDir, 'note.ts'), '// forge an id for the request, then a wave of retries');
    v = checkRegistryConsistency({ templatesDir, registryPath, codeScanDirs: [codeDir] });
    assert.deepEqual(v, [], 'ordinary English forge/wave prose in a codeScanDirs source file is not flagged by the strict scan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // Uses a LOCAL fixture (not the shared CODER_TOKEN_TEMPLATE) named for a
  // surviving agent: 'coder' is no longer a registered agent nor an
  // AGENT_MODEL_KEY entry since the scale-down cut (decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1) deleted coder.md. The
  // reviewers-many-to-one sub-case this test used to carry died with it too —
  // there is no longer a many-to-one AGENT_MODEL_KEY mapping to demonstrate.
  const LIBRARIAN_TOKEN_TEMPLATE = CODER_TOKEN_TEMPLATE.replace('name: coder', 'name: librarian');
  const librarianKey = AGENT_MODEL_KEY['librarian'];
  assert.ok(librarianKey, 'librarian is a registered agent with an AGENT_MODEL_KEY entry');

  const opusModels = { [librarianKey]: { model: 'claude-opus-4-8', effort: 'high' } };
  const { name, installedContent } = renderInstalledAgent(LIBRARIAN_TOKEN_TEMPLATE, 'librarian.md', { ...OPTS, ...cfgBoth(opusModels) });
  assert.equal(name, 'librarian');

  // tokens resolved from config.models[AGENT_MODEL_KEY['librarian']]
  assert.match(frontmatter(installedContent), /^model: claude-opus-4-8$/m, 'MODEL resolved from config.models');
  assert.match(frontmatter(installedContent), /^effort: high$/m, 'EFFORT resolved from config.models');
  assert.ok(!installedContent.includes('{{'), 'no substitution token survives');

  const header = parseInstalledHeader(installedContent);
  // template_hash stays token-form: over the ORIGINAL token template, model-independent.
  assert.equal(header.templateHash, sha256(LIBRARIAN_TOKEN_TEMPLATE), 'template_hash is over the token-form template');
  // content_hash includes substituted values: the self-check passes only if the
  // header hash was computed over the SUBSTITUTED body (not the token form).
  assert.equal(isLocallyModified(installedContent, header), false, 'content_hash covers the substituted values (self-consistent)');

  // Rendering the SAME template with a DIFFERENT model keeps the token-form
  // template_hash but changes the body — proving content_hash tracks the values.
  const sonnetModels = { [librarianKey]: { model: 'claude-sonnet-4-6', effort: 'low' } };
  const other = renderInstalledAgent(LIBRARIAN_TOKEN_TEMPLATE, 'librarian.md', { ...OPTS, ...cfgBoth(sonnetModels) }).installedContent;
  assert.equal(parseInstalledHeader(other).templateHash, sha256(LIBRARIAN_TOKEN_TEMPLATE), 'template_hash is independent of the model chosen');
  assert.match(frontmatter(other), /^model: claude-sonnet-4-6$/m);
  assert.notEqual(other, installedContent, 'a different model yields different installed bytes');
  assert.equal(isLocallyModified(other, header), true, 'content_hash is value-sensitive: sonnet body reads as modified against the opus header');
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
    const coderKey = AGENT_MODEL_KEY['librarian'];
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    // Installed under the template's internal name (librarian), not its source
    // filename (coder.md) — installAgents/syncAgents write to `${name}.md`.
    const installedPath = join(targetAgentsDir, 'librarian.md');

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
    const coderKey = AGENT_MODEL_KEY['librarian'];
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const installedPath = join(targetAgentsDir, 'librarian.md');

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

// -----------------------------------------------------------------------------
// Machine-var drift detection (todo 8789eccf, anti_pattern foreign_60e8463d): a
// machine-context flip (WSL <-> native Windows) leaves an installed agent
// self-consistent and template-current, so hash bookkeeping alone reads it
// up_to_date while every baked hook command points at the other context's
// node. sync must re-bake loudly (machine_rebaked); the visibility gate must
// block on unresolvable baked node paths (opt-in probe); and config-only
// divergence must NOT read as machine drift (phase-4 drift-marker seam).

const MACHINE_TOKEN_TEMPLATE = `---
name: probe-agent
description: Fixture agent with machine-var tokens.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '{{NODE}} "{{HOOKS_DIR}}/h.mjs"'
---

Fixture body line one.
`;

const MACHINE_A = { NODE: '"/machine-a/bin/node"', HOOKS_DIR: '/machine-a/hooks' };
const MACHINE_B = { NODE: '"/machine-b/bin/node"', HOOKS_DIR: '/machine-b/hooks' };

test('extractHookCommandLines/extractBakedCommandPaths read the baked machine surface (node exe AND hook script)', () => {
  const { installedContent } = renderInstalledAgent(MACHINE_TOKEN_TEMPLATE, 'probe-agent.md', { ...OPTS, vars: MACHINE_A });
  assert.deepEqual(extractHookCommandLines(installedContent), [`'"/machine-a/bin/node" "/machine-a/hooks/h.mjs"'`]);
  assert.deepEqual(extractBakedCommandPaths(installedContent), ['/machine-a/bin/node', '/machine-a/hooks/h.mjs']);
  assert.deepEqual(extractHookCommandLines('no frontmatter here'), []);
});

test('syncAgents: unmodified install from the OTHER machine context -> machine_rebaked with THIS machine vars, never up_to_date', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': MACHINE_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: MACHINE_A });
    // same template, same plugin version — only the invoking machine differs
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, vars: MACHINE_B });
    assert.deepEqual(report, [{ name: 'probe-agent', status: 'machine_rebaked' }]);
    const rebaked = readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8');
    assert.deepEqual(extractBakedCommandPaths(rebaked), ['/machine-b/bin/node', '/machine-b/hooks/h.mjs'], 'hook commands re-baked for the invoking machine');
    const header = parseInstalledHeader(rebaked);
    assert.equal(header.installedAt, T1, 'installed_at re-stamped — restart/visibility semantics fire');
    assert.equal(isLocallyModified(rebaked, header), false, 'rebaked install is self-consistent');
    // converges: a second sync from machine B is up_to_date
    const again = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, vars: MACHINE_B });
    assert.deepEqual(again.report, [{ name: 'probe-agent', status: 'up_to_date' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents: a LOCALLY MODIFIED install is never machine-rebaked — modified semantics unchanged (d53dc92c)', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': MACHINE_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: MACHINE_A });
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8') + 'local edit\n');
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, vars: MACHINE_B });
    assert.deepEqual(report, [{ name: 'probe-agent', status: 'locally_modified_up_to_date' }]);
    assert.deepEqual(extractBakedCommandPaths(readFileSync(installedPath, 'utf8')), ['/machine-a/bin/node', '/machine-a/hooks/h.mjs'], 'modified file untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// config_drift (decision sync-agents-reports-config-models-drift-loudly-without-rewriting,
// 256d1059; Dome Farmer #47; closes the silent half of anti_pattern 85d15143):
// an unmodified, template-current install whose frontmatter model/effort differs
// from the resolved config.models entry is reported LOUDLY as config_drift —
// never up_to_date — and sync writes nothing (install/refresh/swap stay the only
// realizing surfaces). Superseded the earlier 'stays up_to_date' pin (98064d77).
test('syncAgents: config-only MODEL divergence on an unmodified install -> config_drift naming both values and the fix, file untouched', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...cfgBoth({ librarian: { model: 'claude-sonnet-4-6', effort: 'high' } }) });
    const installedPath = join(targetAgentsDir, 'librarian.md');
    const before = readFileSync(installedPath, 'utf8');
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, ...cfgBoth({ librarian: { model: 'claude-opus-4-8', effort: 'high' } }) });
    assert.equal(report.length, 1);
    assert.equal(report[0].name, 'librarian');
    assert.equal(report[0].status, 'config_drift', 'a config.models bump sync did not realize is never reported up_to_date');
    assert.deepEqual(report[0].installed, { model: 'claude-sonnet-4-6', effort: 'high' });
    assert.deepEqual(report[0].configured, { model: 'claude-opus-4-8', effort: 'high' });
    assert.equal(report[0].refused, undefined, 'config_drift is a report, not a refusal');
    assert.equal(readFileSync(installedPath, 'utf8'), before, 'sync writes nothing for config_drift — config authority realizes at install/refresh/swap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents: config-only EFFORT divergence -> config_drift; matching config -> up_to_date', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    const models = { librarian: { model: 'claude-sonnet-4-6', effort: 'low' } };
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...cfgBoth(models) });
    const same = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, ...cfgBoth(models) });
    assert.deepEqual(same.report, [{ name: 'librarian', status: 'up_to_date' }]);
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, ...cfgBoth({ librarian: { model: 'claude-sonnet-4-6', effort: 'high' } }) });
    assert.equal(report[0].status, 'config_drift');
    assert.deepEqual(report[0].installed, { model: 'claude-sonnet-4-6', effort: 'low' });
    assert.deepEqual(report[0].configured, { model: 'claude-sonnet-4-6', effort: 'high' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents: config_drift never masks the writing/refusing statuses — refreshed, machine_rebaked, locally_modified_up_to_date and refused_local_modification win', () => {
  const dir = scratch();
  try {
    const modelsA = { librarian: { model: 'claude-sonnet-4-6', effort: 'low' } };
    const modelsB = { librarian: { model: 'claude-opus-4-8', effort: 'high' } };
    const { templatesDir, registryPath } = makePluginSide(dir, { 'coder.md': CODER_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    const installedPath = join(targetAgentsDir, 'librarian.md');

    // template changed + config changed -> refreshed (the fresh render realizes config B)
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...cfgBoth(modelsA) });
    writeFileSync(join(templatesDir, 'coder.md'), CODER_TOKEN_TEMPLATE.replace('Coder fixture body one.', 'Coder fixture body two.'));
    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, ...cfgBoth(modelsB) });
    assert.deepEqual(r.report, [{ name: 'librarian', status: 'refreshed' }]);
    assert.match(frontmatter(readFileSync(installedPath, 'utf8')), /^model: claude-opus-4-8$/m);

    // locally modified, template current, config changed -> locally_modified_up_to_date (hand edits are the user's)
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8') + 'local edit\n');
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, ...cfgBoth(modelsA) });
    assert.deepEqual(r.report, [{ name: 'librarian', status: 'locally_modified_up_to_date' }]);

    // locally modified + template stale + config changed -> refused_local_modification (exit-2 path intact)
    writeFileSync(join(templatesDir, 'coder.md'), CODER_TOKEN_TEMPLATE.replace('Coder fixture body one.', 'Coder fixture body three.'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1, ...cfgBoth(modelsA) });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.equal(r.report[0].refused, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = scratch();
  try {
    // machine flip + config changed -> machine_rebaked (the re-bake writes config B too)
    const MACHINE_MODEL_TEMPLATE = CODER_TOKEN_TEMPLATE.replace(`'"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'`, `'{{NODE}} "{{HOOKS_DIR}}/h.mjs"'`);
    const { templatesDir, registryPath } = makePluginSide(dir2, { 'coder.md': MACHINE_MODEL_TEMPLATE });
    const targetAgentsDir = join(dir2, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: MACHINE_A, ...cfgBoth({ librarian: { model: 'claude-sonnet-4-6', effort: 'low' } }) });
    const r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, vars: MACHINE_B, ...cfgBoth({ librarian: { model: 'claude-opus-4-8', effort: 'high' } }) });
    assert.deepEqual(r.report, [{ name: 'librarian', status: 'machine_rebaked' }]);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('checkAgentsVisible probeExecutability: unresolvable baked node blocks; default contract unchanged', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': MACHINE_TOKEN_TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: MACHINE_A }); // /machine-a/... does not exist here
    const after = '2026-01-01T00:00:01.000Z';
    const legacy = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after });
    assert.equal(legacy.visible, true, 'default contract: pure visibility, no probe');
    const probed = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after, probeExecutability: true });
    assert.equal(probed.visible, false);
    assert.deepEqual(probed.problems, [{ name: 'probe-agent', reason: 'hook_node_unresolvable', detail: '/machine-a/bin/node' }]);
    // a fully resolvable baked command (node exe AND hook script) passes the probe
    rmSync(targetAgentsDir, { recursive: true, force: true });
    const realHooksDir = join(dir, 'hooks-live');
    mkdirSync(realHooksDir, { recursive: true });
    writeFileSync(join(realHooksDir, 'h.mjs'), '// probe fixture');
    const RESOLVABLE = { NODE: `"${process.execPath.replace(/\\/g, '/')}"`, HOOKS_DIR: realHooksDir.replace(/\\/g, '/') };
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: RESOLVABLE });
    const ok = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after, probeExecutability: true });
    assert.equal(ok.visible, true, JSON.stringify(ok.problems));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// checkAgentsVisible: one unreadable installed agent file must not suppress
// the scan of the rest of the registry. Fix: each installed-file read now
// derives its verdict from the read error's code (ENOENT/ENOTDIR ->
// missing_agent; else -> unreadable_agent + detail) instead of letting an
// unguarded readFileSync throw out of the whole loop. SPEC-ONLY: authored from
// the fix's own description (H4 read-wall denies scripts/lib/agent-
// distribution.mjs), verified only against this file's existing
// checkAgentsVisible/probeExecutability conventions above (the {name, reason
// [, detail]} problem shape, and the MACHINE_A unresolvable-node fixture that
// already pins hook_node_unresolvable).
// -----------------------------------------------------------------------------

/** agent-a becomes a DIRECTORY at its installed path (forces EISDIR on a plain
 *  readFileSync; needs no root/chmod trick, portable on Linux and Windows/WSL
 *  alike). agent-b is a real MACHINE_TOKEN_TEMPLATE install under the given
 *  vars, so its OWN verdict is independently checkable regardless of what
 *  happens to agent-a. */
function twoAgentRegistryWithUnreadableA(dir, vars) {
  const { templatesDir, registryPath } = makePluginSide(dir, {
    'agent-a.md': TEMPLATE.replace('probe-agent', 'agent-a'),
    'agent-b.md': MACHINE_TOKEN_TEMPLATE.replace('probe-agent', 'agent-b'),
  });
  const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
  installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars });
  const installedA = join(targetAgentsDir, 'agent-a.md');
  rmSync(installedA, { force: true });
  mkdirSync(installedA); // a directory sits where checkAgentsVisible will readFileSync
  return { registryPath, targetAgentsDir };
}

test('CONTROL, placed first: a fully healthy two-agent registry (no unreadable file, node path resolvable) reports {visible:true, problems:[]}', () => {
  const dir = scratch();
  try {
    const realHooksDir = join(dir, 'hooks-live');
    mkdirSync(realHooksDir, { recursive: true });
    writeFileSync(join(realHooksDir, 'h.mjs'), '// probe fixture');
    const RESOLVABLE = { NODE: `"${process.execPath.replace(/\\/g, '/')}"`, HOOKS_DIR: realHooksDir.replace(/\\/g, '/') };
    // agent-a must be built from MACHINE_TOKEN_TEMPLATE, not TEMPLATE.
    // TEMPLATE bakes TWO Windows literals into one hook command line —
    // '"C:/tools/node.exe" "C:/proj/hooks/h.mjs"' — the interpreter AND the
    // hook script path. A partial replace of only the interpreter still
    // leaves the hook-script literal baked in, and it does not exist on this
    // machine either, so probeExecutability still flags a perfectly
    // "healthy" fixture — for the OTHER literal this time. MACHINE_TOKEN_TEMPLATE
    // (used by agent-b below, and by the passing "unresolvable baked node
    // blocks" / resolvable-probe test above) already carries BOTH as tokens
    // — '{{NODE}} "{{HOOKS_DIR}}/h.mjs"' — so RESOLVABLE's NODE and HOOKS_DIR
    // both actually substitute, for both agents, with nothing left baked.
    const { templatesDir, registryPath } = makePluginSide(dir, {
      'agent-a.md': MACHINE_TOKEN_TEMPLATE.replace('probe-agent', 'agent-a'),
      'agent-b.md': MACHINE_TOKEN_TEMPLATE.replace('probe-agent', 'agent-b'),
    });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: RESOLVABLE });
    const after = '2026-01-01T00:00:01.000Z';
    const v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after, probeExecutability: true });
    assert.deepEqual(v, { visible: true, problems: [] }, 'control: rules out "checkAgentsVisible always reports problems" as the explanation for the two arms below');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// This control has no unreadable file, so restoring the unguarded readFileSync
// (the sabotage below) does not touch this arm at all — it must stay green
// under that mutation, exactly as a control should.

test('an unreadable installed agent file (agent-a, forced EISDIR) is reported unreadable_agent with a plain-language detail, never silently read as current', () => {
  const dir = scratch();
  try {
    const { registryPath, targetAgentsDir } = twoAgentRegistryWithUnreadableA(dir, MACHINE_A);
    const after = '2026-01-01T00:00:01.000Z';
    const v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after, probeExecutability: true });

    assert.equal(v.visible, false);
    const aProblem = v.problems.find((p) => p.name === 'agent-a');
    assert.ok(aProblem, 'agent-a must be reported, not silently dropped from problems');
    assert.equal(aProblem.reason, 'unreadable_agent');
    assert.match(JSON.stringify(aProblem), /(cannot|could not|unable|unreadable|unknown|missing)/i, 'the detail names the read failure in plain terms');
    assert.doesNotMatch(JSON.stringify(aProblem), /up to date/i, 'an unreadable file is never reported as current/up to date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: restore the unguarded readFileSync (drop the try/catch that maps
// the read error's code to unreadable_agent/missing_agent) — this test goes
// red: the EISDIR throw either propagates uncaught out of checkAgentsVisible,
// or (if caught only generically upstream) agent-a's problem never carries
// reason 'unreadable_agent'.

test('THE LOAD-BEARING ARM: agent-b is STILL reported hook_node_unresolvable when agent-a is unreadable — one bad file no longer suppresses the rest of the scan', () => {
  const dir = scratch();
  try {
    const { registryPath, targetAgentsDir } = twoAgentRegistryWithUnreadableA(dir, MACHINE_A);
    const after = '2026-01-01T00:00:01.000Z';
    const v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: after, probeExecutability: true });

    const bProblem = v.problems.find((p) => p.name === 'agent-b');
    assert.ok(bProblem, 'agent-b must still be scanned and reported despite agent-a throwing on read — this is the measured defect the fix closes');
    assert.equal(bProblem.reason, 'hook_node_unresolvable');
    assert.equal(bProblem.detail, '/machine-a/bin/node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: restore the unguarded readFileSync — agent-a's EISDIR throws out
// of the loop before agent-b is ever reached, so `v.problems` never contains
// an agent-b entry (or the whole checkAgentsVisible call throws uncaught,
// failing the test before any assertion runs). This is the arm that actually
// distinguishes "reads are guarded per-file" from "not guarded" or "guarded
// only globally" — the control above stays green under the identical mutation
// because it has no unreadable file to trip it.

// ---------------------------------------------------------------------------
// ensureConductorActivation (route A, decision
// conductor-instructions-via-main-session-agent-route-a): the settings-only
// write that turns an installed .claude/agents/conductor.md into the
// project's actual main-session agent.
// ---------------------------------------------------------------------------

function tmpdtemp() {
  return mkdtempSync(join(tmpdir(), 'sterling-activation-'));
}
function settingsPath(dir) {
  return join(dir, '.claude', 'settings.json');
}
function readSettings(dir) {
  return JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
}

// Sol review MEDIUM finding: feed ensureConductorActivation REAL installAgents/
// syncAgents report objects (produced by actually running them against a fixture
// registry) rather than hand-built {name, status} literals, so a report-shape
// drift in the real functions cannot silently desync from what these tests exercise.
const CONDUCTOR_TEMPLATE = `---
name: conductor
description: Fixture main-session agent for activation tests.
---

# Conductor

Fixture body line one.
`;

// Builds a real templatesDir/registryPath/targetAgentsDir triple for a single
// 'conductor' agent, all under one throwaway `dir` (the same dir doubles as the
// ensureConductorActivation targetDir, since its .claude/agents and
// .claude/settings.json are real siblings in production too).
// Memoized per `dir`: the template is written ONCE (first call) so a test that
// mutates templatesDir/conductor.md between two conductorSync() calls (to force
// a real 'refreshed'/'header_repaired' status) is not clobbered back to the
// original fixture content by a second makePluginSide() write.
const conductorFixtureCache = new Map();
function conductorFixture(dir) {
  if (!conductorFixtureCache.has(dir)) {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'conductor.md': CONDUCTOR_TEMPLATE });
    conductorFixtureCache.set(dir, { templatesDir, registryPath, targetAgentsDir: join(dir, '.claude', 'agents') });
  }
  return conductorFixtureCache.get(dir);
}
function conductorSync(dir, opts = {}) {
  const { templatesDir, registryPath, targetAgentsDir } = conductorFixture(dir);
  return syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, ...opts }).report;
}

test('ensureConductorActivation: no settings.json — creates it with {"agent":"conductor"} (real "installed" report)', () => {
  const dir = tmpdtemp();
  try {
    const report = conductorSync(dir); // missing -> real status 'installed'
    assert.deepEqual(report, [{ name: 'conductor', status: 'installed' }]);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'written');
    assert.deepEqual(readSettings(dir), { agent: 'conductor' });
    assert.match(readFileSync(settingsPath(dir), 'utf8'), /\n$/, 'the written file ends with a newline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: "up_to_date" and "refreshed" (real reports) also activate', () => {
  const dir = tmpdtemp();
  try {
    conductorSync(dir); // installed
    let report = conductorSync(dir); // unchanged -> real 'up_to_date'
    assert.deepEqual(report, [{ name: 'conductor', status: 'up_to_date' }]);
    let result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'written', 'up_to_date activates on a first run (no settings.json yet)');

    // template changes -> real 'refreshed'
    const { templatesDir } = conductorFixture(dir);
    writeFileSync(join(templatesDir, 'conductor.md'), CONDUCTOR_TEMPLATE.replace('line one', 'line one v2'));
    report = conductorSync(dir, { pluginVersion: '0.2.0' });
    assert.deepEqual(report, [{ name: 'conductor', status: 'refreshed' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: "header_repaired" (real report, in-place edit mirrored in the template) counts as success', () => {
  const dir = tmpdtemp();
  try {
    const { templatesDir, registryPath, targetAgentsDir } = conductorFixture(dir);
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    // the pinning incident: the same edit lands in the template AND the installed copy,
    // but the installed header keeps the old hashes (mirrors the syncAgents test above).
    const pinned = CONDUCTOR_TEMPLATE.replace('# Conductor', '# Conductor\n\nAn extra line.');
    writeFileSync(join(templatesDir, 'conductor.md'), pinned);
    const installedPath = join(targetAgentsDir, 'conductor.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('# Conductor', '# Conductor\n\nAn extra line.'));
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(report, [{ name: 'conductor', status: 'header_repaired' }]);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'written', 'a repaired header is a verified install');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: existing settings.json with no "agent" key — sets it, preserving every other key and 2-space formatting', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify({ permissions: { allow: ['Bash'] }, other: 1 }, null, 2) + '\n');
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'written');
    const doc = readSettings(dir);
    assert.equal(doc.agent, 'conductor');
    assert.deepEqual(doc.permissions, { allow: ['Bash'] }, 'unrelated keys survive the merge');
    assert.equal(doc.other, 1);
    assert.match(readFileSync(settingsPath(dir), 'utf8'), /^\{\n  "/, '2-space formatting');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: settings.json carrying a UTF-8 BOM, CRLF line endings, a trailing newline and unrelated keys — merges and preserves all three', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const body = JSON.stringify({ permissions: { allow: ['Bash'] }, marker: 'kept' }, null, 2).replace(/\n/g, '\r\n');
    writeFileSync(settingsPath(dir), '﻿' + body + '\r\n');
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'written');
    const raw = readFileSync(settingsPath(dir), 'utf8');
    assert.equal(raw.charCodeAt(0), '{'.charCodeAt(0), 'the BOM is stripped, never rewritten');
    assert.match(raw, /\r\n/, 'CRLF line endings are preserved');
    assert.ok(!/[^\r]\n/.test(raw), 'no bare LF is introduced among the CRLF pairs');
    assert.match(raw, /\r\n$/, 'the trailing newline is preserved');
    const doc = JSON.parse(raw);
    assert.equal(doc.agent, 'conductor');
    assert.deepEqual(doc.permissions, { allow: ['Bash'] });
    assert.equal(doc.marker, 'kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: a settings.json with NO trailing newline stays that way after the merge', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify({ marker: 'no-eol' }, null, 2)); // no trailing \n
    const report = conductorSync(dir);
    ensureConductorActivation(dir, report);
    assert.doesNotMatch(readFileSync(settingsPath(dir), 'utf8'), /\n$/, 'no trailing newline was introduced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: "agent" already "conductor" — reports already, writes nothing', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const original = JSON.stringify({ agent: 'conductor', marker: 'untouched' }, null, 2);
    writeFileSync(settingsPath(dir), original);
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'already');
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), original, 'byte-identical — no write occurred');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: "agent" set to a different value — refuses, writes nothing', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const original = JSON.stringify({ agent: 'someone-else' }, null, 2);
    writeFileSync(settingsPath(dir), original);
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'refused');
    assert.match(result.reason, /someone-else/);
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), original, 'byte-identical — the deliberate choice is never overwritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: malformed JSON — refuses, writes nothing', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), '{ not json');
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'refused');
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), '{ not json', 'byte-identical — never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: settings.json is a JSON array (non-object) — refuses, writes nothing', () => {
  const dir = tmpdtemp();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), '[1,2,3]');
    const report = conductorSync(dir);
    const result = ensureConductorActivation(dir, report);
    assert.equal(result.activation, 'refused');
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), '[1,2,3]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: skipped on a real "foreign_file" report, a real "refused_local_modification" report, an absent conductor entry, and an empty report', () => {
  const dir = tmpdtemp();
  try {
    // real foreign_file: pre-seed the target with a non-sterling file at the conductor path
    const { templatesDir, registryPath, targetAgentsDir } = conductorFixture(dir);
    mkdirSync(targetAgentsDir, { recursive: true });
    writeFileSync(join(targetAgentsDir, 'conductor.md'), '---\nname: conductor\n---\nhand-written, no sterling header\n');
    let { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(report, [{ name: 'conductor', status: 'foreign_file', refused: true, instruction: report[0].instruction }]);
    assert.equal(ensureConductorActivation(dir, report).activation, 'skipped');

    // real refused_local_modification: install clean, hand-edit the body, then change the template
    const dir2 = tmpdtemp();
    try {
      const f2 = conductorFixture(dir2);
      syncAgents({ templatesDir: f2.templatesDir, registryPath: f2.registryPath, targetAgentsDir: f2.targetAgentsDir, ...OPTS });
      const installedPath = join(f2.targetAgentsDir, 'conductor.md');
      writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('Fixture body line one.', 'a real local edit'));
      writeFileSync(join(f2.templatesDir, 'conductor.md'), CONDUCTOR_TEMPLATE.replace('line one', 'line one v2'));
      const r2 = syncAgents({ templatesDir: f2.templatesDir, registryPath: f2.registryPath, targetAgentsDir: f2.targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
      assert.equal(r2.report[0].status, 'refused_local_modification');
      assert.equal(ensureConductorActivation(dir2, r2.report).activation, 'skipped');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }

    for (const badReport of [
      [{ name: 'implementor', status: 'installed' }], // no conductor entry at all
      [],
    ]) {
      assert.equal(ensureConductorActivation(dir, badReport).activation, 'skipped', JSON.stringify(badReport));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureConductorActivation: "installed" / "up_to_date" / "refreshed" all count as success (real reports; "header_repaired" is covered separately above)', () => {
  for (const makeReport of [
    (dir) => conductorSync(dir),
    (dir) => {
      conductorSync(dir);
      return conductorSync(dir);
    },
    (dir) => {
      conductorSync(dir);
      const { templatesDir } = conductorFixture(dir);
      writeFileSync(join(templatesDir, 'conductor.md'), CONDUCTOR_TEMPLATE.replace('line one', 'line one v2'));
      return conductorSync(dir, { pluginVersion: '0.2.0' });
    },
  ]) {
    const dir = tmpdtemp();
    try {
      const report = makeReport(dir);
      const result = ensureConductorActivation(dir, report);
      assert.equal(result.activation, 'written', `status '${report[0].status}' must activate`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Regression: sync-agents exited 0 on a sync refusal because syncAgents omitted
// `refused: true` for foreign_file / refused_local_modification (installAgents set
// it), so /sterling:update printed the refusal as a change and could stamp
// update-complete.json while the agent stayed stale. The CLI contract is exit 2.
const SYNC_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sync-agents.mjs');
const runSyncCli = (target) => spawnSync(process.execPath, [SYNC_CLI, '--target', target], { encoding: 'utf8' });

// config_drift through the CLI (decision 256d1059): a sparse project config that
// bumps one model (other keys filled from the zod defaults, as install-agents
// resolves it) prints a status line naming agent, installed + configured
// model/effort and the fix command; exit 0 (a report, not a gate); nothing written.
test('sync-agents CLI reports config_drift loudly, exits 0, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sync-cli-'));
  try {
    const first = runSyncCli(dir);
    assert.equal(first.status, 0, `clean install must exit 0:\n${first.stdout}${first.stderr}`);
    const agentPath = join(dir, '.claude', 'agents', 'implementor.md');
    const before = readFileSync(agentPath, 'utf8');
    const installedModel = frontmatter(before).match(/^model:\s*(\S+)$/m)[1];
    const installedEffort = frontmatter(before).match(/^effort:\s*(\S+)$/m)[1];
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ models: { implementor: { model: 'claude-drift-probe-9', effort: 'xhigh' } } }));
    const r = runSyncCli(dir);
    assert.equal(r.status, 0, `config_drift is a report, not a refusal:\n${r.stdout}${r.stderr}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('config_drift: implementor'));
    assert.ok(line, `a config_drift status line for implementor:\n${r.stdout}`);
    assert.ok(line.includes(`model=${installedModel}`) && line.includes(`effort=${installedEffort}`), `names the installed model/effort: ${line}`);
    assert.ok(line.includes('model=claude-drift-probe-9') && line.includes('effort=xhigh'), `names the configured model/effort: ${line}`);
    assert.ok(line.includes('node scripts/install-agents.mjs') && line.includes('--target <dir>'), `names the fix command: ${line}`);
    assert.doesNotMatch(r.stdout, /^up_to_date: implementor$/m, 'never up_to_date over a dead config bump');
    assert.doesNotMatch(r.stdout, /^config_drift: (?!implementor)/m, 'agents whose config was not bumped do not drift');
    assert.equal(readFileSync(agentPath, 'utf8'), before, 'sync writes nothing for config_drift');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, tamper, status] of [
  [
    'a hand-edited registered agent whose template is stale',
    (path) => {
      const content = readFileSync(path, 'utf8');
      const header = parseInstalledHeader(content);
      const staleHeader = header.headerLine.replace(`template_hash=${header.templateHash}`, `template_hash=${'0'.repeat(64)}`);
      writeFileSync(path, content.replace(header.headerLine, staleHeader).replace(/\n$/, '\nA hand edit.\n'));
    },
    'refused_local_modification',
  ],
  [
    'a header-less registered agent file',
    (path) => writeFileSync(path, '---\nname: implementor\ndescription: hand-written\n---\nNot Sterling-generated.\n'),
    'foreign_file',
  ],
]) {
  test(`sync-agents CLI exits 2 on ${label} (${status})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-sync-cli-'));
    try {
      const first = runSyncCli(dir);
      assert.equal(first.status, 0, `clean install must exit 0:\n${first.stdout}${first.stderr}`);
      const agentPath = join(dir, '.claude', 'agents', 'implementor.md');
      tamper(agentPath);
      const before = readFileSync(agentPath, 'utf8');
      const r = runSyncCli(dir);
      assert.match(r.stdout, new RegExp(`^${status}: implementor$`, 'm'));
      assert.equal(r.status, 2, `a sync refusal must exit 2:\n${r.stdout}${r.stderr}`);
      assert.equal(readFileSync(agentPath, 'utf8'), before, 'refused file must be untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// -----------------------------------------------------------------------------
// Per-project agent tool extension (decision
// per-project-agent-extra-tools-config-appended-at-render, 587472e3; Dome Farmer
// #50): config.agents.<name>.extra_tools is appended to the rendered tools: line.
// Templates carry no token, so template_hash stays sha256(raw template); the
// content_hash covers the rendered output, so the file is NOT locally modified.
const EXTRAS = (name, extra_tools) => ({ agents: { [name]: { extra_tools } } });
const toolsLine = (s) => frontmatter(s).match(/^tools:\s*(.*)$/m)[1];

test('extra_tools: render appends de-duplicated extras to the tools: line; template_hash unchanged; not locally modified', () => {
  const plain = renderInstalledAgent(TEMPLATE, 'probe.md', OPTS);
  const { installedContent } = renderInstalledAgent(TEMPLATE, 'probe.md', {
    ...OPTS,
    config: EXTRAS('probe-agent', ['mcp__godot__*', 'Read', 'mcp__godot__*', 'WebFetch']),
  });
  assert.equal(toolsLine(installedContent), 'Read, mcp__godot__*, WebFetch', 'extras appended once each; a tool the template already grants is not repeated');
  const header = parseInstalledHeader(installedContent);
  assert.equal(header.templateHash, sha256(TEMPLATE), 'template_hash is the raw template hash — extras never move it');
  assert.equal(header.templateHash, parseInstalledHeader(plain.installedContent).templateHash);
  assert.equal(isLocallyModified(installedContent, header), false, 'the rendered extras are covered by content_hash');
  assert.equal(frontmatter(installedContent).replace(/^tools:.*$/m, ''), frontmatter(plain.installedContent).replace(/^tools:.*$/m, ''), 'only the tools: line changes');
});

test('extra_tools: absent or empty extras render byte-identically to no config', () => {
  const plain = renderInstalledAgent(TEMPLATE, 'probe.md', OPTS).installedContent;
  assert.equal(renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: { agents: {} } }).installedContent, plain);
  assert.equal(renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: EXTRAS('probe-agent', []) }).installedContent, plain);
  assert.equal(renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: EXTRAS('someone-else', ['mcp__godot__*']) }).installedContent, plain, 'another agent\'s extras do not leak');
});

test('extra_tools: refused loudly for an agent without a tools: line (main-session conductor inherits every tool)', () => {
  const noTools = TEMPLATE.replace('tools: Read\n', '');
  assert.throws(
    () => renderInstalledAgent(noTools, 'conductor.md', { ...OPTS, config: EXTRAS('probe-agent', ['mcp__godot__*']) }),
    /extra_tools.*probe-agent.*no tools: line/,
  );
});

test('extra_tools: refused loudly for any entry that would grant Sterling MCP tools (grants stay the template\'s job, b4388c11)', () => {
  for (const bad of ['mcp__sterling__knowledge_update', 'mcp__plugin_sterling_sterling__board_add', 'mcp__sterling__*', 'mcp__sterling', 'mcp__plugin_sterling_sterling', 'mcp__*', 'mcp__ster*']) {
    assert.throws(
      () => renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: EXTRAS('probe-agent', [bad]) }),
      /extra_tools.*Sterling MCP/,
      `entry ${bad} must be refused`,
    );
  }
});

test('extra_tools: a malformed entry reaching render unparsed is refused (newline would inject frontmatter)', () => {
  for (const bad of ['mcp__a\nhooks:', 'a, b', '', 42]) {
    assert.throws(
      () => renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: EXTRAS('probe-agent', [bad]) }),
      /extra_tools.*not a valid tool name/,
      `entry ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('extra_tools: an agent key not in the registry is refused by install AND sync, before anything is written', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    const config = EXTRAS('implementr', ['mcp__godot__*']);
    assert.throws(() => installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, config }), /config\.agents.*'implementr'.*not a registered agent/);
    assert.throws(() => syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, config }), /config\.agents.*'implementr'.*not a registered agent/);
    assert.equal(existsSync(join(targetAgentsDir, 'probe-agent.md')), false, 'nothing written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extra_tools: an extras-only config change -> sync reports config_drift naming the tools difference, writes nothing; install realizes it; then up_to_date', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, config: EXTRAS('probe-agent', ['WebFetch']) });
    const before = readFileSync(installedPath, 'utf8');
    const config = EXTRAS('probe-agent', ['mcp__godot__*']);
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, config });
    assert.equal(report.length, 1);
    assert.equal(report[0].status, 'config_drift', 'an extras-only change is never up_to_date (anti_pattern 85d15143)');
    assert.equal(report[0].refused, undefined, 'config_drift is a report, not a refusal');
    assert.deepEqual(report[0].tools, { missing: ['mcp__godot__*'], unexpected: ['WebFetch'] });
    assert.match(describeConfigDrift(report[0]), /tools: missing mcp__godot__\*; unexpected WebFetch/);
    assert.doesNotMatch(describeConfigDrift(report[0]), /model=/, 'model/effort did not drift, so the line does not claim it did');
    assert.equal(readFileSync(installedPath, 'utf8'), before, 'sync writes nothing for config_drift');

    const inst = installAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, config });
    assert.equal(inst.report[0].status, 'installed');
    assert.equal(toolsLine(readFileSync(installedPath, 'utf8')), 'Read, mcp__godot__*');
    const after = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, config });
    assert.deepEqual(after.report, [{ name: 'probe-agent', status: 'up_to_date' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extra_tools: a template refresh picks the extras up (stale template -> refreshed with the configured tools)', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    writeFileSync(join(templatesDir, 'probe.md'), TEMPLATE.replace('Fixture body line one.', 'Fixture body line two.'));
    const { report } = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.1.0', now: T1, config: EXTRAS('probe-agent', ['mcp__godot__*']) });
    assert.equal(report[0].status, 'refreshed');
    assert.equal(toolsLine(readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8')), 'Read, mcp__godot__*');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describeConfigDrift: a model-only drift keeps naming installed and configured model/effort', () => {
  const line = describeConfigDrift({ installed: { model: 'a', effort: 'low' }, configured: { model: 'b', effort: 'low' } });
  assert.match(line, /installed model=a effort=low, config\.models resolves model=b effort=low/);
});

const INSTALL_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'install-agents.mjs');

test('install-agents + sync-agents CLI: extras render into the real researcher (not scout), an extras-only change reports config_drift (exit 0, nothing written); extras on the inherit-all implementor or the conductor fail the install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-extras-cli-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ agents: { researcher: { extra_tools: ['mcp__godot__*'] } } }));
    const inst = spawnSync(process.execPath, [INSTALL_CLI, '--target', dir], { encoding: 'utf8' });
    assert.equal(inst.status, 0, `install must exit 0:\n${inst.stdout}${inst.stderr}`);
    const agentPath = join(dir, '.claude', 'agents', 'researcher.md');
    const installed = readFileSync(agentPath, 'utf8');
    assert.ok(toolsLine(installed).endsWith(', mcp__godot__*'), `extras appended: ${toolsLine(installed)}`);
    assert.doesNotMatch(toolsLine(readFileSync(join(dir, '.claude', 'agents', 'scout.md'), 'utf8')), /godot/, 'per-agent, never global');
    const clean = runSyncCli(dir);
    assert.match(clean.stdout, /^up_to_date: researcher$/m, `installed extras are current:\n${clean.stdout}`);

    writeFileSync(cfgPath, JSON.stringify({ agents: { researcher: { extra_tools: [] } } }));
    const r = runSyncCli(dir);
    assert.equal(r.status, 0, `config_drift is a report, not a refusal:\n${r.stdout}${r.stderr}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('config_drift: researcher'));
    assert.ok(line, `a config_drift status line for researcher:\n${r.stdout}`);
    assert.ok(line.includes('unexpected mcp__godot__*'), `names the tools difference: ${line}`);
    assert.equal(readFileSync(agentPath, 'utf8'), installed, 'sync writes nothing for config_drift');

    for (const agent of ['implementor', 'conductor']) {
      writeFileSync(cfgPath, JSON.stringify({ agents: { [agent]: { extra_tools: ['mcp__godot__*'] } } }));
      const refused = spawnSync(process.execPath, [INSTALL_CLI, '--target', dir], { encoding: 'utf8' });
      assert.notEqual(refused.status, 0, `extras on the ${agent} fail the install`);
      assert.match(refused.stderr, new RegExp(`'${agent}'.*no tools: line`), `names the problem:\n${refused.stderr}`);
      const refusedSync = runSyncCli(dir);
      assert.notEqual(refusedSync.status, 0, `extras on the ${agent} fail the sync too`);
      assert.equal(readFileSync(agentPath, 'utf8'), installed, 'a refused install writes nothing');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extra_tools: refused loudly for an inherit-all agent (disallowedTools, no tools: line — the implementor shape, bc1894e5)', () => {
  const inheritAll = TEMPLATE.replace('tools: Read\n', 'disallowedTools: mcp__sterling__board_add, mcp__plugin_sterling_sterling__board_add\n');
  assert.throws(
    () => renderInstalledAgent(inheritAll, 'implementor.md', { ...OPTS, config: EXTRAS('probe-agent', ['mcp__godot__*']) }),
    /extra_tools.*probe-agent.*no tools: line.*inherits every session tool/,
  );
});

// Review fixes (#50): malformed agents entries parse fine (the schema is lenient
// so a typo never breaks MCP boot or a hook) but FAIL install with a named
// refusal; the Sterling-prefix ban is case-insensitive.
test('extra_tools: a malformed agents entry does not break parseConfig but does fail install/sync with a named refusal', async () => {
  const { parseConfig } = await import('@sterling/schemas');
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'target', '.claude', 'agents');
    for (const [raw, re] of [
      [{ agents: { 'probe-agent': { extra_tools: ['a, b'] } } }, /extra_tools for 'probe-agent'.*"a, b" is not a valid tool name/],
      [{ agents: { 'probe-agent': { extra_tool: ['mcp__godot__*'] } } }, /config\.agents\.probe-agent: unknown key 'extra_tool'/],
      [{ agents: { 'probe-agent': { extra_tools: 'a' } } }, /config\.agents\.probe-agent\.extra_tools .*not an array/],
    ]) {
      const config = parseConfig(raw);
      assert.throws(() => installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, config }), re);
      assert.throws(() => syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, config }), re);
    }
    assert.equal(existsSync(join(targetAgentsDir, 'probe-agent.md')), false, 'nothing written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extra_tools: the Sterling-prefix ban is case-insensitive', () => {
  for (const bad of ['MCP__sterling__x', 'mcp__Sterling__knowledge_update', 'Mcp__Plugin_Sterling_Sterling', 'MCP__*']) {
    assert.throws(
      () => renderInstalledAgent(TEMPLATE, 'probe.md', { ...OPTS, config: EXTRAS('probe-agent', [bad]) }),
      /extra_tools.*Sterling MCP/,
      `entry ${bad} must be refused`,
    );
  }
});
