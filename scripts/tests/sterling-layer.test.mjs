// Sterling's layer as a generated, marked section of AGENTS.md (GitHub #329, decisions
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer and the
// home-Sterling host ruling): regeneration in place, retirement of CLAUDE.md / GEMINI.md that hold
// only Sterling's text, and the byte bounds that keep AGENTS.md inside agy's 24,000-byte cap.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgyText, renderClaudeText } from '../lib/agent-fences.mjs';
import { renderDomains, renderStackTags } from '../lib/agents-md-facts.mjs';
import {
  AGENTS_MD_MAX_BYTES,
  CLAUDE_BLOCK_MAX_BYTES,
  LAYER_END,
  LayerMarkerError,
  applyLayer,
  isPureSterlingHostFile,
  readClaudeSessionBlock,
  readLayerSection,
  retireHostFiles,
  syncLayer,
} from '../lib/sterling-layer.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sterling-layer-')); dirs.push(d); return d; };
const bytes = (s) => Buffer.byteLength(s, 'utf8');

const hostTemplate = () => readFileSync(join(repo, 'templates', 'target-claude-md.md'), 'utf8');
const claudeRender = (name = 'demo') => renderClaudeText(hostTemplate(), 't').replaceAll('{{PROJECT_NAME}}', name);
const agyRender = (name = 'demo') => renderAgyText(hostTemplate(), 't').replaceAll('{{PROJECT_NAME}}', name).replaceAll('{{STERLING_ROOT}}', '/opt/sterling');

test('applyLayer appends the section when there are no markers, keeping the file as written', () => {
  const section = readLayerSection(repo);
  const out = applyLayer('# Mine\n\nRule one.\n', section);
  assert.ok(out.startsWith('# Mine\n\nRule one.\n\n'));
  assert.ok(out.endsWith(`${LAYER_END}\n`));
});

test('applyLayer regenerates in place and leaves every byte outside the markers alone', () => {
  const section = readLayerSection(repo);
  const before = `# Mine\n\nTop rule.\n\n${section.replace('Sterling layer (generated)', 'OLD TEXT')}\n\n## After\n\n- project rule after the block\n`;
  const out = applyLayer(before, section);
  assert.ok(out.startsWith('# Mine\n\nTop rule.\n\n'));
  assert.ok(out.endsWith('\n\n## After\n\n- project rule after the block\n'));
  assert.ok(!out.includes('OLD TEXT'));
  assert.equal(applyLayer(out, section), out, 'a second pass changes nothing');
});

test('applyLayer keeps CRLF line endings', () => {
  const section = readLayerSection(repo);
  const out = applyLayer('# Mine\r\n\r\nRule.\r\n', section);
  assert.ok(!/[^\r]\n/.test(out), 'every newline is CRLF');
});

test('applyLayer refuses a begin without its end, a stray end, and repeated markers', () => {
  const section = readLayerSection(repo);
  const begin = section.split('\n')[0];
  for (const text of [`# X\n\n${begin}\n\nno end\n`, `# X\n\n${LAYER_END}\n`, `${section}\n\n${section}\n`, `${LAYER_END}\n${begin}\n`]) {
    assert.throws(() => applyLayer(text, section), LayerMarkerError);
  }
});

test('AGENTS.md as init renders it for a fresh agy project stays within 21,000 bytes, leaving 3,000 under the 24,000 cap', () => {
  const section = readLayerSection(repo);
  const tags = ['node', 'typescript', 'sterling'];
  const template = readFileSync(join(repo, 'templates', 'target-agents-md.md'), 'utf8')
    .replaceAll('{{PROJECT_NAME}}', 'a-project-with-a-fairly-long-name')
    .replaceAll('{{STACK_TAGS}}', renderStackTags(tags))
    .replaceAll('{{TOOLCHAINS}}', 'node (`**/*.mjs`, `**/*.ts`); dotnet (`**/*.cs`)')
    .replaceAll('{{LINT_COMMAND}}', '`npm run lint` (node)')
    .replaceAll('{{DOMAINS}}', renderDomains(tags))
    .replaceAll('{{BACKUP_PATH}}', 'configured — see `.sterling/config.json` → `backup_path` (machine-local, deliberately not restated here)')
    .replace('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
  const rendered = applyLayer(template, section);
  assert.ok(bytes(rendered) <= AGENTS_MD_MAX_BYTES, `${bytes(rendered)} bytes is over ${AGENTS_MD_MAX_BYTES}`);
  assert.equal(AGENTS_MD_MAX_BYTES, 21_000);
  assert.ok(bytes(rendered) < 24_000 - 3_000 + 1);
});

test('the Claude Code session block is at most 2,000 bytes', () => {
  const block = readClaudeSessionBlock(repo);
  assert.ok(bytes(block) <= CLAUDE_BLOCK_MAX_BYTES, `${bytes(block)} bytes`);
  assert.equal(CLAUDE_BLOCK_MAX_BYTES, 2_000);
});

test('the shipped layer names the shared rules once and holds no machine path', () => {
  const section = readLayerSection(repo);
  assert.doesNotMatch(section, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(section, /\/home\/|C:\\|\/Users\//);
});

test('a CLAUDE.md that is Sterling\'s render, the one-line import, or an older template render is pure; one with an extra bullet is not', () => {
  assert.equal(isPureSterlingHostFile(claudeRender(), 'claude', repo), true);
  assert.equal(isPureSterlingHostFile('@AGENTS.md\n', 'claude', repo), true);
  assert.equal(isPureSterlingHostFile(`${claudeRender()}\n- **Mine.** A project rule.\n`, 'claude', repo), false);
  assert.equal(isPureSterlingHostFile('# Hand written\n\nOnly my rules.\n', 'claude', repo), false);
});

test('a GEMINI.md that is Sterling\'s agy render is pure; an edited one is not', () => {
  assert.equal(isPureSterlingHostFile(agyRender(), 'agy', repo), true);
  assert.equal(isPureSterlingHostFile(agyRender().replace('Durable conventions', 'My conventions'), 'agy', repo), false);
});

test('retireHostFiles removes a pure-Sterling CLAUDE.md and GEMINI.md and says so', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  writeFileSync(join(dir, 'GEMINI.md'), agyRender());
  const { rows, warns } = retireHostFiles({ projectDir: dir, pluginRoot: repo });
  assert.deepEqual(rows.map((r) => [r.item, r.status]), [['CLAUDE.md', 'removed'], ['GEMINI.md', 'removed']]);
  assert.deepEqual(warns, []);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
});

test('retireHostFiles keeps a hand-edited CLAUDE.md byte for byte and warns that it hides AGENTS.md from Claude Code', () => {
  const dir = tmp();
  const edited = `${claudeRender()}\n- **Mine.** A rule only this project has.\n`;
  writeFileSync(join(dir, 'CLAUDE.md'), edited);
  const { rows, warns } = retireHostFiles({ projectDir: dir, pluginRoot: repo });
  assert.deepEqual(rows.map((r) => [r.item, r.status]), [['CLAUDE.md', 'kept']]);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), edited);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /CLAUDE\.md/);
  assert.match(warns[0], /Claude Code ignores AGENTS\.md/);
});

test('retireHostFiles keeps a hand-written GEMINI.md and names it in the warning', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'GEMINI.md'), '# Mine\n\nagy rules of my own.\n');
  const { rows, warns } = retireHostFiles({ projectDir: dir, pluginRoot: repo });
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(warns[0], /GEMINI\.md/);
  assert.equal(existsSync(join(dir, 'GEMINI.md')), true);
});

test('syncLayer regenerates the section, preserves project rules outside the markers and retires a pure CLAUDE.md', () => {
  const dir = tmp();
  const section = readLayerSection(repo);
  writeFileSync(join(dir, 'AGENTS.md'), `# P\n\n- **Mine.** Keep me.\n\n${section.replace('Sterling layer (generated)', 'STALE')}\n\n- **Also mine.**\n`);
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const lines = syncLayer({ projectDir: dir, pluginRoot: repo });
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('- **Mine.** Keep me.'));
  assert.ok(agents.includes('- **Also mine.**'));
  assert.ok(!agents.includes('STALE'));
  assert.ok(lines.some((l) => /regenerated/.test(l)));
  assert.ok(lines.some((l) => /^CLAUDE\.md removed/.test(l)));
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.ok(syncLayer({ projectDir: dir, pluginRoot: repo }).some((l) => /up to date/.test(l)));
});

test('syncLayer on broken markers leaves AGENTS.md untouched and warns', () => {
  const dir = tmp();
  const broken = `# P\n\n${readLayerSection(repo).split('\n')[0]}\n\nno end\n`;
  writeFileSync(join(dir, 'AGENTS.md'), broken);
  const lines = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), broken);
  assert.ok(lines.some((l) => /marker/.test(l)));
});
