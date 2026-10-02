// Host-conditional rendering (board item parity-p3-the-full-roster-plus-a-fully-host-mapped-conductor):
// one agent template renders for Claude Code and for OpenCode. claude-only blocks
// reach only the Claude render, opencode-only blocks only the OpenCode renders, so
// the Claude conductor stays byte-identical while the OpenCode conductor carries no
// Claude-only instruction. Also pins the six-role Sterling-full roster's permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFences, renderClaudeText, renderPortableText, renderOpenCodeFullText } from '../lib/agent-fences.mjs';
import { loadRegistry } from '../lib/agent-distribution.mjs';
import { ROSTER, STERLING_AGENTS_SUBDIR, renderFullOpenCodeAgent, setupOpenCode } from '../lib/opencode-install.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The last commit before the host fences entered conductor.md: its Claude render is the baseline.
const PRE_HOST_FENCE_COMMIT = '9c7533f';

const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const registry = () => loadRegistry(join(repoRoot, 'agent-templates', 'registry.json'));
const fullRender = (name) => {
  const entry = registry().agents.find((a) => a.name === name);
  return renderFullOpenCodeAgent(read(`agent-templates/${entry.file}`), entry.file, entry, { primary: name === 'conductor' }).content;
};
const frontmatter = (content) => content.match(/^---\n([\s\S]*?)\n---\n/)[1];

test('host fences: claude-only reaches only the Claude render, opencode-only only the OpenCode renders', () => {
  const text = 'a\n<!-- claude-only -->\nclaude\n<!-- /claude-only -->\n<!-- opencode-only -->\nopencode\n<!-- /opencode-only -->\nz\n';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderClaudeText(text, 't'), 'a\nclaude\nz\n');
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nopencode\nz\n');
  assert.equal(renderPortableText(text, 't'), 'a\nopencode\nz\n');
});

test('host fences: the OpenCode-full render keeps sterling-only content and drops portable-only blocks', () => {
  const text = 'a\n<!-- sterling-only -->\nsterling\n<!-- /sterling-only -->\n<!-- portable-only -->\nportable\n<!-- /portable-only -->\nz\n';
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nsterling\nz\n');
});

test('host fences: nesting, a mismatched close and a misspelled marker are refused loudly', () => {
  const cases = {
    nested: ['<!-- claude-only -->', '<!-- opencode-only -->', 'x', '<!-- /opencode-only -->', '<!-- /claude-only -->'],
    mismatched: ['<!-- claude-only -->', 'x', '<!-- /opencode-only -->'],
    misspelled: ['<!-- Claude-Only -->', 'x', '<!-- /claude-only -->'],
    unclosed: ['<!-- opencode-only -->', 'x'],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const text = `${lines.join('\n')}\n`;
    assert.ok(validateFences(text, 'f.md').length > 0, name);
    assert.throws(() => renderClaudeText(text, 'f.md'), /agent fences invalid in f\.md/, name);
    assert.throws(() => renderOpenCodeFullText(text, 'f.md'), /agent fences invalid in f\.md/, name);
  }
});

test('host fences: an empty claude-only or opencode-only block is refused, a blank-only one too', () => {
  const cases = {
    'empty claude-only': ['a', '<!-- claude-only -->', '<!-- /claude-only -->', '<!-- opencode-only -->', 'o', '<!-- /opencode-only -->'],
    'claude-only holding only the no-counterpart marker': ['a', '<!-- claude-only -->', '<!-- no-opencode-counterpart -->', '<!-- /claude-only -->'],
    'blank-only claude-only': ['a', '<!-- claude-only -->', '', '<!-- /claude-only -->', '<!-- opencode-only -->', 'o', '<!-- /opencode-only -->'],
    'empty opencode-only': ['a', '<!-- claude-only -->', 'c', '<!-- /claude-only -->', '<!-- opencode-only -->', '<!-- /opencode-only -->'],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const text = `${lines.join('\n')}\n`;
    const v = validateFences(text, 'f.md');
    assert.deepEqual(v.map((x) => x.kind), ['fence_empty_block'], name);
    assert.match(v[0].detail, /^f\.md:\d+: the (claude|opencode)-only block is empty/, name);
    assert.throws(() => renderOpenCodeFullText(text, 'f.md'), /fence_empty_block/, name);
  }
});

test('the Claude-rendered conductor is byte-identical to its render before the host fences', () => {
  const r = spawnSync('git', ['show', `${PRE_HOST_FENCE_COMMIT}:agent-templates/conductor.md`], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, `git show ${PRE_HOST_FENCE_COMMIT}: ${r.stderr}`);
  const now = read('agent-templates/conductor.md');
  assert.match(now, /^<!-- opencode-only -->$/m, 'the template carries host fences');
  assert.equal(renderClaudeText(now, 'conductor.md'), renderClaudeText(r.stdout, 'conductor.md'));
});

test('the OpenCode conductor names no Claude-only mechanism and carries the OpenCode mapping', () => {
  const content = fullRender('conductor');
  for (const claudeOnly of ['SendMessage', 'claude --resume', '/clear', '.claude/settings.json', 'READY TO CLEAR', '`Plan` agent', 'model: "fable"', 'running in Claude Code', 'general-purpose', '.claude/agents/']) {
    assert.ok(!content.includes(claudeOnly), `OpenCode conductor still names ${JSON.stringify(claudeOnly)}`);
  }
  for (const mapped of ['READY FOR NEW SESSION', '/new', 'sessionID', 'opencode --session', 'sterling/reviewer', 'sterling/librarian', '.opencode/opencode.json', 'default_agent', 'running in OpenCode', 'dispatch those names']) {
    assert.ok(content.includes(mapped), `OpenCode conductor lacks ${JSON.stringify(mapped)}`);
  }
  assert.match(frontmatter(content), /^mode: primary$/m);
});

test('roster: all six roles render for OpenCode, the conductor primary and the rest subagents', () => {
  assert.deepEqual([...ROSTER].sort(), ['conductor', 'implementor', 'librarian', 'researcher', 'reviewer', 'scout']);
  const home = mkdtempSync(join(tmpdir(), 'oc-host-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'oc-host-proj-'));
  for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't'], ['config', 'core.autocrlf', 'false']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const result = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: () => ({ installed: true, version: '2.0.21', major: 2 }) });
  for (const name of ROSTER) {
    const row = result.rows.find((r) => r.item === `${STERLING_AGENTS_SUBDIR}/${name}.md`);
    assert.equal(row?.status, 'created', name);
    const fm = frontmatter(readFileSync(join(dir, STERLING_AGENTS_SUBDIR, `${name}.md`), 'utf8'));
    assert.match(fm, name === 'conductor' ? /^mode: primary$/m : /^mode: subagent$/m, name);
  }
});

test('roster permissions: the reviewer is read-only with no store write; the librarian writes only the store', () => {
  const reviewer = frontmatter(fullRender('reviewer'));
  for (const line of ['edit: deny', 'webfetch: deny', 'task: deny', 'sterling_knowledge_create: deny', 'sterling_knowledge_update: deny', 'sterling_board_add: deny', 'sterling_maintenance_remove: deny']) {
    assert.match(reviewer, new RegExp(`^  ${line}$`, 'm'), `reviewer: ${line}`);
  }
  assert.doesNotMatch(reviewer, /^ {2}bash: deny$/m, 'the reviewer keeps bash (its Claude grant has Bash)');
  assert.doesNotMatch(reviewer, /sterling_knowledge_(query|get)|sterling_board_(query|get)/, 'the reviewer keeps its store reads');

  const librarian = frontmatter(fullRender('librarian'));
  for (const line of ['edit: deny', 'bash: deny', 'webfetch: deny', 'task: deny']) {
    assert.match(librarian, new RegExp(`^  ${line}$`, 'm'), `librarian: ${line}`);
  }
  assert.doesNotMatch(librarian, /sterling_\w+: deny/, 'the librarian keeps its store-write tools');

  for (const name of ['implementor', 'researcher', 'scout']) {
    assert.match(frontmatter(fullRender(name)), /^ {2}sterling_knowledge_create: deny$/m, `${name} holds no store write`);
  }
  assert.doesNotMatch(frontmatter(fullRender('conductor')), /permission:/, 'the conductor is unrestricted');
});

test('the portable (committed) set is unchanged: reviewer and librarian stay out of it', () => {
  const portable = registry().agents.filter((a) => a.opencode !== undefined).map((a) => a.name).sort();
  assert.deepEqual(portable, ['implementor', 'researcher', 'scout']);
});
