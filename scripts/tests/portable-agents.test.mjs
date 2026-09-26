// Portable (OpenCode) agents — decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections, refinements (b)-(e):
// one fenced agent source, a Claude render left byte-identical, a portable render
// free of Sterling vocabulary, translated OpenCode frontmatter with no model pin,
// deterministic provenance, and syncAgents-style ownership (refuse local edits and
// foreign files; a renderer or permission change invalidates, not only the template).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@sterling/schemas';
import { validateFences, renderClaudeText, renderPortableText, findPortableVocabulary } from '../lib/agent-fences.mjs';
import { renderInstalledAgent, loadRegistry, parseInstalledHeader } from '../lib/agent-distribution.mjs';
import {
  renderOpenCodeAgent,
  syncOpenCodeAgents,
  portableAgentEntries,
  parseOpenCodeHeader,
  OPENCODE_RENDERER,
  OPENCODE_AGENTS_DIR,
} from '../lib/opencode-agents.mjs';
import { lintAgentFences } from '../lib/checks.mjs';
import { isSterlingClone } from '../lib/handoff-projection.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = join(root, 'agent-templates');
const registryPath = join(templatesDir, 'registry.json');
const PORTABLE = ['implementor', 'researcher', 'scout'];
const template = (name) => readFileSync(join(templatesDir, `${name}.md`), 'utf8');

// ---------------------------------------------------------------- fences

test('fences: a sterling-only block keeps its content for Claude and is dropped for the portable render', () => {
  const text = 'a\n<!-- sterling-only -->\nb\n<!-- /sterling-only -->\nc\n';
  assert.equal(renderClaudeText(text, 't'), 'a\nb\nc\n');
  assert.equal(renderPortableText(text, 't'), 'a\nc\n');
});

test('fences: a portable-only block is dropped for Claude and kept for the portable render', () => {
  const text = 'a\n<!-- sterling-only -->\nold\n<!-- /sterling-only -->\n<!-- portable-only -->\nnew\n<!-- /portable-only -->\nc\n';
  assert.equal(renderClaudeText(text, 't'), 'a\nold\nc\n');
  assert.equal(renderPortableText(text, 't'), 'a\nnew\nc\n');
});

test('fences: CRLF input renders like LF', () => {
  const text = 'a\r\n<!-- sterling-only -->\r\nb\r\n<!-- /sterling-only -->\r\nc\r\n';
  assert.equal(renderPortableText(text, 't'), 'a\nc\n');
  assert.deepEqual(validateFences(text, 't'), []);
});

test('fences: unbalanced, nested, mismatched and malformed markers fail loudly', () => {
  const cases = [
    ['a\n<!-- sterling-only -->\nb\n', 'fence_unclosed'],
    ['a\n<!-- /sterling-only -->\n', 'fence_unopened'],
    ['<!-- sterling-only -->\n<!-- portable-only -->\n<!-- /portable-only -->\n<!-- /sterling-only -->\n', 'fence_nested'],
    ['<!-- sterling-only -->\nx\n<!-- /portable-only -->\n', 'fence_mismatched'],
    ['<!-- sterling-only-->\nx\n', 'fence_malformed'],
    ['text <!-- sterling-only -->\n', 'fence_malformed'],
    // Sol review (fence leak): a marker spelled in another case, or split across
    // a multiline HTML comment, must be rejected — never ignored as prose, which
    // would leak its block into the portable render.
    ['<!-- STERLING-ONLY -->\nsecret\n<!-- /STERLING-ONLY -->\n', 'fence_malformed'],
    ['<!-- Portable-Only -->\nx\n<!-- /Portable-Only -->\n', 'fence_malformed'],
    ['<!--\nsterling-only\n-->\nsecret\n<!-- /sterling-only -->\n', 'fence_malformed'],
    ['<!-- note:\n  /sterling-only -->\n', 'fence_malformed'],
    ['<!-- sterling only -->\nsecret\n', 'fence_malformed'],
    ['<!-- sterling-only\n', 'fence_malformed'],
  ];
  for (const [text, kind] of cases) {
    const kinds = validateFences(text, 'fixture.md').map((v) => v.kind);
    assert.ok(kinds.includes(kind), `${JSON.stringify(text)} must report ${kind}, got ${kinds.join(', ')}`);
    assert.throws(() => renderPortableText(text, 'fixture.md'), /agent fences invalid in fixture\.md/);
    assert.throws(() => renderClaudeText(text, 'fixture.md'), /agent fences invalid in fixture\.md/);
  }
});

test('fences: lintAgentFences reports violations as check entries and passes every shipped template', () => {
  assert.deepEqual(lintAgentFences('<!-- sterling-only -->\n', 'x.md').map((v) => v.kind), ['fence_unclosed']);
  for (const file of readdirSync(templatesDir).filter((f) => f.endsWith('.md'))) {
    assert.deepEqual(lintAgentFences(readFileSync(join(templatesDir, file), 'utf8'), file), [], file);
  }
});

test('fences: lintAgentFences flags Sterling vocabulary left in a portable agent render', () => {
  const leaky = '---\nname: scout\ndescription: d\n---\n\nRun `knowledge_query` first.\n';
  const kinds = lintAgentFences(leaky, 'scout.md').map((v) => v.kind);
  assert.deepEqual(kinds, ['portable_vocabulary']);
  // a non-portable agent (librarian) is not vocabulary-checked
  assert.deepEqual(lintAgentFences(leaky.replace('scout', 'librarian'), 'librarian.md'), []);
});

test('check-agent-prompts runs the fence and vocabulary lint over the shipped templates', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-agent-prompts.mjs')], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /fences ok/);
});

// ------------------------------------------------- Claude render unchanged

// Pinned to 703a327, the last commit before the templates were fenced: the
// fencing (and every portable rewrite, which lives in portable-only blocks) must
// leave each installed Claude agent byte-identical apart from the header's
// template_hash. If a LATER commit edits a template's Claude-visible prose on
// purpose, move this pin to that commit — the pin guards the fencing, not the prose.
const FENCE_BASELINE = '703a327';
// conductor.md's Claude-visible prose changed on purpose in 797307f (work-mode
// push and review rules, decision project-mode-hobby-work-toggle-decides-flow)
// and again in 42b8f23 (work-mode landing; Sol-before-PR over Terra→Opus) and
// 706dd57 (run the pr-review-loop skill after a work-mode PR), 6661665
// (state READY TO CLEAR plainly) and 993c29b (a store-unsettleable consequential
// choice goes through the grill skill, decision sterling-grill-skill-design);
// those last two meet in the release/0.18.16 merge, so its pin moves to
// 993c29b; every other template stays pinned to 703a327.
const BASELINE_OVERRIDES = { 'conductor.md': '993c29b' };
const renderConfig = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
const renderOpts = { pluginVersion: '0.0.0-test', now: '2026-01-01T00:00:00.000Z', vars: { NODE: '"/usr/bin/node"', HOOKS_DIR: '/x/hooks', GIT_RO: '/x/git-ro.mjs' }, config: renderConfig };
const withoutHeader = (content) => content.replace(parseInstalledHeader(content).headerLine + '\n', '');

for (const entry of loadRegistry(registryPath).agents) {
  const baseline = BASELINE_OVERRIDES[entry.file] ?? FENCE_BASELINE;
  test(`Claude render of ${entry.file} is byte-identical to the ${baseline} render (header aside)`, () => {
    const shown = spawnSync('git', ['show', `${baseline}:agent-templates/${entry.file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(shown.status, 0, `git show ${baseline} failed: ${shown.stderr}`);
    const before = renderInstalledAgent(shown.stdout, entry.file, renderOpts).installedContent;
    const after = renderInstalledAgent(template(entry.name), entry.file, renderOpts).installedContent;
    assert.equal(withoutHeader(after), withoutHeader(before));
    assert.doesNotMatch(after, /(sterling|portable)-only/, 'no marker line may reach a Claude agent');
  });
}

// ------------------------------------------------------ portable render

test('the portable set is declared once, in the registry: implementor, researcher, scout (librarian and conductor excluded)', () => {
  assert.deepEqual(portableAgentEntries(loadRegistry(registryPath)).map((e) => e.name), PORTABLE);
});

const EXPECTED_FRONTMATTER = {
  implementor: [
    '---',
    `description: ${template('implementor').match(/^description: (.*)$/m)[1]}`,
    'mode: subagent',
    '---',
  ].join('\n'),
  researcher: [
    '---',
    // the registry's portable description override (the template's says 'holds no store-write grant')
    `description: ${JSON.stringify('Read-only research and investigation. Traces how code works, maps dependencies, reads docs and git history, and reports evidence-backed findings. Cannot edit. The default investigator for "how does X work", "where is Y handled", or "trace this code path".')}`,
    'mode: subagent',
    'permission:',
    '  edit: deny',
    '  webfetch: deny',
    '  task: deny',
    '---',
  ].join('\n'),
  scout: [
    '---',
    `description: ${template('scout').match(/^description: (.*)$/m)[1]}`,
    'mode: subagent',
    'permission:',
    '  edit: deny',
    '  bash: deny',
    '  webfetch: deny',
    '  task: deny',
    '---',
  ].join('\n'),
};

for (const entry of portableAgentEntries(loadRegistry(registryPath))) {
  test(`OpenCode frontmatter snapshot: ${entry.name}`, () => {
    const { content } = renderOpenCodeAgent(template(entry.name), entry.file, entry.opencode);
    assert.equal(content.slice(0, content.indexOf('\n---\n') + 4), EXPECTED_FRONTMATTER[entry.name]);
    assert.doesNotMatch(content, /^model:|^effort:|^tools:|^disallowedTools:|^required_inputs:|^name:/m, 'Claude-only keys and the model pin are dropped');
  });

  test(`portable frontmatter description of ${entry.name} carries no Sterling vocabulary`, () => {
    const { content } = renderOpenCodeAgent(template(entry.name), entry.file, entry.opencode);
    const description = content.match(/^description: (.*)$/m)[1];
    assert.deepEqual(findPortableVocabulary(description), []);
  });

  test(`portable body of ${entry.name} carries no Sterling vocabulary and no fence marker`, () => {
    const { content } = renderOpenCodeAgent(template(entry.name), entry.file, entry.opencode);
    const header = parseOpenCodeHeader(content);
    const body = content.replace(header.headerLine + '\n', '');
    assert.deepEqual(findPortableVocabulary(body), []);
    assert.doesNotMatch(body, /(sterling|portable)-only/);
  });

  test(`portable render of ${entry.name} is deterministic: no timestamp, provenance = renderer + template hash + content hash`, () => {
    const a = renderOpenCodeAgent(template(entry.name), entry.file, entry.opencode).content;
    const b = renderOpenCodeAgent(template(entry.name), entry.file, entry.opencode).content;
    assert.equal(a, b);
    assert.doesNotMatch(a, /installed_at|\d{4}-\d{2}-\d{2}T\d{2}:/);
    const header = parseOpenCodeHeader(a);
    assert.equal(header.renderer, OPENCODE_RENDERER);
    assert.equal(header.template, entry.name);
    assert.match(header.templateHash, /^[0-9a-f]{64}$/);
    assert.match(header.contentHash, /^[0-9a-f]{64}$/);
  });
}

test('the vocabulary scan covers the portable description: a template description with Sterling vocabulary fails the lint unless the registry overrides it', () => {
  const leaky = '---\nname: scout\ndescription: Holds no store-write grant.\n---\n\nPlain body.\n';
  assert.deepEqual(lintAgentFences(leaky, 'scout.md', { 'scout.md': {} }).map((v) => v.kind), ['portable_vocabulary']);
  assert.deepEqual(lintAgentFences(leaky, 'scout.md', { 'scout.md': { description: 'Finds files. Cannot edit.' } }), []);
  assert.deepEqual(lintAgentFences(leaky, 'scout.md', { 'scout.md': { description: 'Uses knowledge_query.' } }).map((v) => v.kind), ['portable_vocabulary']);
  assert.deepEqual(lintAgentFences('---\nname: librarian\ndescription: store-write clerk\n---\n', 'librarian.md'), [], 'a non-portable agent is not vocabulary-checked');
});

test('the registry refuses a portable description that is not one non-empty line', () => {
  const dir = tempTarget();
  try {
    for (const bad of ['', 'two\nlines', 42]) {
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      registry.agents.find((a) => a.name === 'scout').opencode.description = bad;
      writeFileSync(join(dir, 'r.json'), JSON.stringify(registry));
      assert.throws(() => loadRegistry(join(dir, 'r.json')), /opencode\.description/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the portable render refuses a permission key or value OpenCode does not document', () => {
  assert.throws(() => renderOpenCodeAgent(template('scout'), 'scout.md', { permission: { edit: 'nope' } }), /permission/);
  assert.throws(() => renderOpenCodeAgent(template('scout'), 'scout.md', { permission: { teleport: 'deny' } }), /permission/);
});

// ------------------------------------------------------------------ sync

function tempTarget() {
  return mkdtempSync(join(tmpdir(), 'sterling-opencode-'));
}
const statusOf = (report) => Object.fromEntries(report.map((r) => [r.name, r.status]));

test('sync installs exactly the portable set, then reports up_to_date without rewriting', () => {
  const dir = tempTarget();
  try {
    const first = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    assert.deepEqual(statusOf(first.report), { implementor: 'installed', researcher: 'installed', scout: 'installed' });
    assert.deepEqual(readdirSync(join(dir, OPENCODE_AGENTS_DIR)).sort(), ['implementor.md', 'researcher.md', 'scout.md']);
    const second = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    assert.deepEqual(statusOf(second.report), { implementor: 'up_to_date', researcher: 'up_to_date', scout: 'up_to_date' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A registry whose scout permission map differs stands in for a renderer or
// permission change: the template hash is unchanged, so only content-hash
// invalidation can see it.
function changedRegistry(dir) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.agents.find((a) => a.name === 'scout').opencode.permission.bash = 'ask';
  const path = join(dir, 'registry.json');
  writeFileSync(path, JSON.stringify(registry));
  return path;
}

test('sync refreshes an unmodified agent when the permission map changes (template hash unchanged)', () => {
  const dir = tempTarget();
  try {
    syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    const report = syncOpenCodeAgents({ registryPath: changedRegistry(dir), templatesDir, targetDir: dir }).report;
    assert.equal(statusOf(report).scout, 'refreshed');
    assert.match(readFileSync(join(dir, OPENCODE_AGENTS_DIR, 'scout.md'), 'utf8'), /^ {2}bash: ask$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync refreshes an unmodified agent when the renderer version changes', () => {
  const dir = tempTarget();
  try {
    syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    const report = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir, renderer: 'opencode/999' }).report;
    assert.deepEqual(new Set(report.map((r) => r.status)), new Set(['refreshed']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync never overwrites a local edit: current render -> locally_modified_up_to_date; changed render -> refused', () => {
  const dir = tempTarget();
  try {
    syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    const scoutPath = join(dir, OPENCODE_AGENTS_DIR, 'scout.md');
    const edited = readFileSync(scoutPath, 'utf8') + '\nA local rule this team added.\n';
    writeFileSync(scoutPath, edited);

    const same = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    assert.equal(statusOf(same.report).scout, 'locally_modified_up_to_date');
    assert.equal(readFileSync(scoutPath, 'utf8'), edited);

    const changed = syncOpenCodeAgents({ registryPath: changedRegistry(dir), templatesDir, targetDir: dir });
    const entry = changed.report.find((r) => r.name === 'scout');
    assert.equal(entry.status, 'refused_local_modification');
    assert.equal(entry.refused, true);
    assert.match(entry.instruction, /\.opencode\/agents\/scout\.md/);
    assert.equal(readFileSync(scoutPath, 'utf8'), edited, 'the edited file is left byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync refuses a foreign same-named file and leaves it untouched', () => {
  const dir = tempTarget();
  try {
    mkdirSync(join(dir, OPENCODE_AGENTS_DIR), { recursive: true });
    const foreign = '---\ndescription: our own scout\nmode: subagent\n---\n\nHand-written.\n';
    writeFileSync(join(dir, OPENCODE_AGENTS_DIR, 'scout.md'), foreign);
    const { report } = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    const entry = report.find((r) => r.name === 'scout');
    assert.equal(entry.status, 'foreign_file');
    assert.equal(entry.refused, true);
    assert.equal(readFileSync(join(dir, OPENCODE_AGENTS_DIR, 'scout.md'), 'utf8'), foreign);
    assert.equal(statusOf(report).implementor, 'installed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sync-agents CLI (the /sterling:update fan-out) writes the portable set and exits 2 on a portable refusal', () => {
  const dir = tempTarget();
  try {
    // the portable set is work-only (decision project-mode-hobby-work-toggle-decides-flow)
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work' }));
    const cli = () => spawnSync(process.execPath, [join(root, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir });
    const first = cli();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    for (const name of PORTABLE) assert.match(first.stdout, new RegExp(`^installed: \\.opencode/agents/${name}\\.md$`, 'm'));
    writeFileSync(join(dir, OPENCODE_AGENTS_DIR, 'scout.md'), '---\ndescription: ours\nmode: subagent\n---\n');
    const second = cli();
    assert.equal(second.status, 2, second.stdout + second.stderr);
    assert.match(second.stdout, /^foreign_file: \.opencode\/agents\/scout\.md$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSterlingClone (the skip sync-agents and init apply): this clone and any Sterling checkout yes, a target no', () => {
  const dir = tempTarget();
  try {
    assert.equal(isSterlingClone(root, root), true);
    assert.equal(isSterlingClone(root, dir), true, 'recognized by its manifest even when it is not the running plugin root');
    assert.equal(isSterlingClone(dir, root), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Sol review HIGH (symlink escape): a symlinked .opencode, .opencode/agents or
// agent file must never let the sync read or write outside the project.
for (const [label, link, toFile] of [
  ['.opencode', '.opencode', false],
  ['.opencode/agents', '.opencode/agents', false],
  ['an agent file', '.opencode/agents/scout.md', true],
]) {
  test(`sync refuses a symlinked ${label}, writing nothing outside the project`, () => {
    const dir = tempTarget();
    const outside = mkdtempSync(join(tmpdir(), 'sterling-opencode-outside-'));
    try {
      writeFileSync(join(outside, 'scout.md'), 'outside content\n');
      mkdirSync(dirname(join(dir, link)), { recursive: true });
      symlinkSync(toFile ? join(outside, 'scout.md') : outside, join(dir, link));
      const { report } = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
      const refused = report.filter((r) => r.status === 'refused_unsafe_path');
      assert.ok(refused.length >= 1, JSON.stringify(report));
      for (const r of refused) {
        assert.equal(r.refused, true);
        assert.match(r.instruction, /symlink/);
      }
      assert.deepEqual(readdirSync(outside), ['scout.md'], 'nothing new outside');
      assert.equal(readFileSync(join(outside, 'scout.md'), 'utf8'), 'outside content\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test('sync refuses an agent path the target already ignores, naming the rule; nothing written', () => {
  const dir = tempTarget();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, '.gitignore'), '.opencode/\n');
    const { report } = syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    assert.deepEqual(new Set(report.map((r) => r.status)), new Set(['refused_ignored']));
    for (const r of report) {
      assert.equal(r.refused, true);
      assert.match(r.instruction, /\.gitignore:1:\.opencode\//);
    }
    assert.ok(!existsSync(join(dir, OPENCODE_AGENTS_DIR)), 'nothing written');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.opencode/\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sync-agents CLI refuses (exit 2) when a symlinked plugin.json would spoof Sterling-clone detection', () => {
  const dir = tempTarget();
  const outside = mkdtempSync(join(tmpdir(), 'sterling-opencode-outside-'));
  try {
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify({ name: 'sterling' }));
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'architecture-projection.mjs'), '// project file\n');
    symlinkSync(join(outside, 'plugin.json'), join(dir, '.claude-plugin', 'plugin.json'));
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^refused_unsafe_path: \.opencode\/agents\/ — .*plugin\.json is a symlink/m);
    assert.doesNotMatch(r.stdout, /SKIPPED — the target is a Sterling clone/);
    assert.ok(!existsSync(join(dir, OPENCODE_AGENTS_DIR)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('sync treats a CRLF checkout of an unmodified agent as up_to_date', () => {
  const dir = tempTarget();
  try {
    syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir });
    const p = join(dir, OPENCODE_AGENTS_DIR, 'implementor.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(statusOf(syncOpenCodeAgents({ registryPath, templatesDir, targetDir: dir }).report).implementor, 'up_to_date');
    assert.ok(existsSync(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
