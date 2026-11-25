// Sterling's layer as a generated, marked section of AGENTS.md (GitHub #329, decisions
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer and the
// home-Sterling host ruling): regeneration in place, retirement of CLAUDE.md / GEMINI.md that hold
// only Sterling's text, and the byte bounds that keep AGENTS.md inside agy's 24,000-byte cap.
// The safety cases (review of #329) pin that project text is never deleted or altered: exact
// markers outside code only, byte-for-byte splices, whole-file matches against trusted renders,
// retirement only after the section is verified on disk, and the cap enforced before any write.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgyText, renderClaudeText } from '../lib/agent-fences.mjs';
import { renderDomains, renderStackTags } from '../lib/agents-md-facts.mjs';
import {
  AGENTS_MD_AGY_CAP_BYTES,
  AGENTS_MD_MAX_BYTES,
  CLAUDE_BLOCK_MAX_BYTES,
  LAYER_END,
  LayerMarkerError,
  applyLayer,
  classifyHostFile,
  plannedAgentsMdRefusal,
  knownHostValues,
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
const claudeRender = (name = 'demo', template = hostTemplate()) => renderClaudeText(template, 't').replaceAll('{{PROJECT_NAME}}', name);
const agyRender = (name = 'demo', root = repo) => renderAgyText(hostTemplate(), 't').replaceAll('{{PROJECT_NAME}}', name).replaceAll('{{STERLING_ROOT}}', root);

// A project whose recorded name is `demo`: the name the trusted render is filled with.
function project({ agents } = {}) {
  const dir = tmp();
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'demo' }));
  if (agents !== undefined) writeFileSync(join(dir, 'AGENTS.md'), agents);
  return dir;
}
const validAgents = () => `# P\n\n- **Mine.** Keep me.\n\n${readLayerSection(repo)}\n`;
const read = (dir, file) => readFileSync(join(dir, file), 'utf8');

// ---- markers and the splice ----

test('applyLayer appends the section after the file exactly as written', () => {
  const section = readLayerSection(repo);
  assert.equal(applyLayer('# Mine\n\nRule one.\n', section), `# Mine\n\nRule one.\n\n${section}\n`);
  assert.equal(applyLayer('# Mine', section), `# Mine\n\n${section}\n`);
});

test('applyLayer keeps trailing spaces and blank lines at the end of the file when it appends', () => {
  const section = readLayerSection(repo);
  const text = '# Mine\n\nRule with two trailing spaces.  \n\n\n';
  const out = applyLayer(text, section);
  assert.ok(out.startsWith(text), 'every byte of the project text is kept');
  assert.equal(out, `${text}\n${section}\n`);
});

test('applyLayer regenerates in place and leaves every byte outside the markers alone', () => {
  const section = readLayerSection(repo);
  const before = `# Mine\n\nTop rule.\n\n${section.replace('Sterling layer (generated)', 'OLD TEXT')}\n\n## After\n\n- project rule after the block\n`;
  const out = applyLayer(before, section);
  assert.equal(out, `# Mine\n\nTop rule.\n\n${section}\n\n## After\n\n- project rule after the block\n`);
  assert.equal(applyLayer(out, section), out, 'a second pass changes nothing');
});

test('applyLayer keeps CRLF line endings', () => {
  const section = readLayerSection(repo);
  const out = applyLayer('# Mine\r\n\r\nRule.\r\n', section);
  assert.ok(!/[^\r]\n/.test(out), 'every newline is CRLF');
  assert.equal(applyLayer(out, section), out);
});

test('applyLayer on a mixed-EOL file keeps every line ending outside the block as it was', () => {
  const section = readLayerSection(repo);
  const head = '# Mine\r\n\nLF line\r\nCRLF line\r\n\n';
  const tail = '\n\nafter LF\r\nafter CRLF\n';
  const old = section.replace('Sterling layer (generated)', 'OLD').split('\n').join('\n');
  const out = applyLayer(`${head}${old}${tail}`, section);
  assert.ok(out.startsWith(head), 'bytes before the block unchanged');
  assert.ok(out.endsWith(tail), 'bytes after the block unchanged');
  assert.equal(out, `${head}${section}${tail}`);
});

test('applyLayer refuses a begin without its end, a stray end, repeated markers and an end before its begin', () => {
  const section = readLayerSection(repo);
  const begin = section.split('\n')[0];
  for (const text of [`# X\n\n${begin}\n\nno end\n`, `# X\n\n${LAYER_END}\n`, `${section}\n\n${section}\n`, `${LAYER_END}\n${begin}\n`]) {
    assert.throws(() => applyLayer(text, section), LayerMarkerError);
  }
});

test('applyLayer refuses a begin marker line missing its closing --> even with a valid end marker later, and erases nothing', () => {
  const section = readLayerSection(repo);
  const broken = `# P\n\n<!-- sterling:begin generated (init and update rewrite this block\n\n- **My rule.** Must survive.\n\n${LAYER_END}\n`;
  assert.throws(() => applyLayer(broken, section), LayerMarkerError);
});

test('applyLayer ignores marker lines inside fenced code: an example is not the section, and a real section beside it is replaced alone', () => {
  const section = readLayerSection(repo);
  const begin = section.split('\n')[0];
  const example = `## How the markers look\n\n\`\`\`md\n${begin}\n(example)\n${LAYER_END}\n\`\`\`\n`;
  assert.equal(applyLayer(example, section), `${example}\n${section}\n`, 'no real markers: appended, example kept');
  const withReal = `${example}\n${section.replace('Sterling layer (generated)', 'OLD')}\n`;
  assert.equal(applyLayer(withReal, section), `${example}\n${section}\n`, 'only the real section is replaced');
});

test('applyLayer refuses a file whose code fence is never closed, since its markers cannot be told from code', () => {
  const section = readLayerSection(repo);
  assert.throws(() => applyLayer('# P\n\n```sh\necho open\n', section), LayerMarkerError);
});

// ---- byte bounds and the shipped text ----

test('AGENTS.md as init renders it for a fresh agy project with a typical name stays within about 21,000 bytes; with a 100-character name it is still under the 24,000 cap', () => {
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
  const longName = 'p'.repeat(100);
  const long = applyLayer(template.replaceAll('a-project-with-a-fairly-long-name', longName), section);
  assert.ok(long.includes(longName));
  assert.ok(bytes(long) < AGENTS_MD_AGY_CAP_BYTES, `${bytes(long)} bytes with a 100-character name`);
  assert.equal(plannedAgentsMdRefusal(long, section), null);
  assert.equal(AGENTS_MD_MAX_BYTES, 21_000);
  assert.equal(AGENTS_MD_AGY_CAP_BYTES, 24_000);
});

test('the Claude Code session block is at most 2,000 bytes', () => {
  const block = readClaudeSessionBlock(repo);
  assert.ok(bytes(block) <= CLAUDE_BLOCK_MAX_BYTES, `${bytes(block)} bytes`);
  assert.equal(CLAUDE_BLOCK_MAX_BYTES, 2_000);
});

test('the shipped layer holds no token or machine path', () => {
  const section = readLayerSection(repo);
  assert.doesNotMatch(section, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(section, /\/home\/|C:\\|\/Users\//);
});

test('each host gets its own root and rotation line: the agy path and READY FOR NEW SESSION only under the agy heading, READY TO CLEAR only in the Claude Code block', () => {
  const section = readLayerSection(repo);
  const agyAt = section.indexOf('### On Antigravity CLI (agy) only');
  assert.ok(agyAt > 0);
  const shared = section.slice(0, agyAt);
  const agy = section.slice(agyAt);
  assert.ok(!shared.includes('.gemini'), 'the shared text names no agy path');
  assert.ok(!shared.includes('READY FOR NEW SESSION') && !shared.includes('READY TO CLEAR'), 'the shared text names no host rotation literal');
  assert.match(agy, /`<root>` and `CLAUDE_PLUGIN_ROOT` mean `~\/\.gemini\/config\/plugins\/sterling`/);
  assert.match(agy, /READY FOR NEW SESSION/);
  assert.match(agy, /EXIT AND RELAUNCH/);
  assert.ok(!shared.includes('EXIT AND RELAUNCH') && !shared.includes('RELOAD'), 'the shared text names no host reload literal');
  const claude = readClaudeSessionBlock(repo);
  assert.match(claude, /READY TO CLEAR/);
  assert.doesNotMatch(claude, /READY FOR NEW SESSION/);
});

// ---- host files: what counts as Sterling's own text ----

const known = (dir) => knownHostValues({ projectDir: dir, pluginRoot: repo });

test('classifyHostFile: the current render with the project\'s own name, the one-line import and the agy render with a known root are pure', () => {
  const dir = project();
  assert.equal(classifyHostFile(claudeRender(), 'claude', { pluginRoot: repo, known: known(dir) }).pure, true);
  assert.equal(classifyHostFile(claudeRender().replace(/\n/g, '\r\n'), 'claude', { pluginRoot: repo, known: known(dir) }).pure, true, 'CRLF folds to LF');
  assert.equal(classifyHostFile('@AGENTS.md\n', 'claude', { pluginRoot: repo, known: known(dir) }).pure, true);
  assert.equal(classifyHostFile(agyRender(), 'agy', { pluginRoot: repo, known: known(dir) }).pure, true);
});

test('classifyHostFile: a rule added on the project-name heading line, another project name, an extra line, trailing text or another root is not pure', () => {
  const dir = project();
  const k = known(dir);
  const cases = [
    claudeRender().replace('# CLAUDE.md — demo (Sterling layer)', '# CLAUDE.md — demo. Always use tabs. (Sterling layer)'),
    claudeRender('someone-else'),
    `${claudeRender()}\n- **Mine.** A project rule.\n`,
    `${claudeRender()}  `,
    '# Hand written\n\nOnly my rules.\n',
  ];
  for (const text of cases) assert.equal(classifyHostFile(text, 'claude', { pluginRoot: repo, known: k }).pure, false, text.slice(0, 80));
  assert.equal(classifyHostFile(agyRender('demo', '/opt/elsewhere'), 'agy', { pluginRoot: repo, known: k }).pure, false, 'a root that is not known is not filled in');
});

// A real older render, checked from a plugin copy with no git: only the shipped history decides.
function noGitPluginRoot({ history = true } = {}) {
  const root = tmp();
  mkdirSync(join(root, 'templates'));
  mkdirSync(join(root, 'bin'));
  cpSync(join(repo, 'templates', 'target-claude-md.md'), join(root, 'templates', 'target-claude-md.md'));
  if (history) cpSync(join(repo, 'bin', 'host-file-history.json'), join(root, 'bin', 'host-file-history.json'));
  return root;
}
const olderTemplate = () => {
  const shas = spawnSync('git', ['log', '--format=%H', '--', 'templates/target-claude-md.md'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const current = claudeRender('demo');
  for (const sha of shas) {
    const text = spawnSync('git', ['show', `${sha}:templates/target-claude-md.md`], { cwd: repo, encoding: 'utf8' }).stdout;
    try {
      if (claudeRender('demo', text) !== current) return text;
    } catch {
      // a revision the current renderer refuses is not a usable fixture; try the next older one
    }
  }
  throw new Error('fixture: no older claude render differs from the current one');
};

test('classifyHostFile on an installed copy without git: an older render is pure through the shipped history; a missing history is reported as could-not-verify, not as project text', () => {
  const dir = project();
  const older = claudeRender('demo', olderTemplate());
  const withHistory = noGitPluginRoot();
  assert.equal(existsSync(join(withHistory, '.git')), false);
  assert.deepEqual(classifyHostFile(older, 'claude', { pluginRoot: withHistory, known: known(dir) }), { pure: true });
  assert.deepEqual(classifyHostFile(`${older}- **Mine.**\n`, 'claude', { pluginRoot: withHistory, known: known(dir) }), { pure: false });
  const without = noGitPluginRoot({ history: false });
  const verdict = classifyHostFile(older, 'claude', { pluginRoot: without, known: known(dir) });
  assert.equal(verdict.pure, false);
  assert.match(verdict.unverified, /host-file-history\.json is missing/);
});

// ---- retirement: only after the layer is verified, only a regular file, only Sterling's text ----

const OK = { ok: true };

test('retireHostFiles removes a pure CLAUDE.md and GEMINI.md once the layer is verified', () => {
  const dir = project();
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  writeFileSync(join(dir, 'GEMINI.md'), agyRender());
  const { rows } = retireHostFiles({ projectDir: dir, pluginRoot: repo, known: known(dir), layer: OK });
  assert.deepEqual(rows.map((r) => [r.item, r.status]), [['CLAUDE.md', 'removed'], ['GEMINI.md', 'removed']]);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
});

test('retireHostFiles keeps every host file, untouched, when the layer is not verified, and says why', () => {
  const dir = project();
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const { rows } = retireHostFiles({ projectDir: dir, pluginRoot: repo, known: known(dir), layer: { ok: false, reason: 'no AGENTS.md' } });
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(rows[0].warning, /not verified in AGENTS\.md \(no AGENTS\.md\)/);
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
});

test('retireHostFiles keeps a hand-edited CLAUDE.md byte for byte and warns that it hides AGENTS.md from Claude Code', () => {
  const dir = project();
  const edited = `${claudeRender()}\n- **Mine.** A rule only this project has.\n`;
  writeFileSync(join(dir, 'CLAUDE.md'), edited);
  const { rows } = retireHostFiles({ projectDir: dir, pluginRoot: repo, known: known(dir), layer: OK });
  assert.deepEqual(rows.map((r) => [r.item, r.status]), [['CLAUDE.md', 'kept']]);
  assert.equal(read(dir, 'CLAUDE.md'), edited);
  assert.match(rows[0].warning, /holds text that is not Sterling's generated layer/);
  assert.match(rows[0].warning, /Claude Code ignores AGENTS\.md/);
});

test('retireHostFiles keeps a CLAUDE.md that is a directory or a symbolic link, and one it cannot read, each with a warning', () => {
  const dirAsFile = project();
  mkdirSync(join(dirAsFile, 'CLAUDE.md'));
  let { rows } = retireHostFiles({ projectDir: dirAsFile, pluginRoot: repo, known: known(dirAsFile), layer: OK });
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(rows[0].warning, /not a regular file \(a directory\)/);
  assert.ok(lstatSync(join(dirAsFile, 'CLAUDE.md')).isDirectory());

  const linked = project();
  const target = join(tmp(), 'pure.md');
  writeFileSync(target, claudeRender());
  symlinkSync(target, join(linked, 'CLAUDE.md'));
  ({ rows } = retireHostFiles({ projectDir: linked, pluginRoot: repo, known: known(linked), layer: OK }));
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(rows[0].warning, /a symbolic link/);
  assert.ok(lstatSync(join(linked, 'CLAUDE.md')).isSymbolicLink(), 'the link is still there');

  // The read failure is injected (a mode-000 file is readable as root).
  const unreadable = project();
  writeFileSync(join(unreadable, 'CLAUDE.md'), claudeRender());
  const eacces = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  ({ rows } = retireHostFiles({ projectDir: unreadable, pluginRoot: repo, known: known(unreadable), layer: OK, readFile: eacces }));
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(rows[0].warning, /could not be read \(EACCES\)/);
  assert.equal(read(unreadable, 'CLAUDE.md'), claudeRender());
});

test('retireHostFiles keeps a file it cannot verify and says "could not be verified", separately from project text', () => {
  const dir = project();
  const older = claudeRender('demo', olderTemplate());
  writeFileSync(join(dir, 'CLAUDE.md'), older);
  const { rows } = retireHostFiles({ projectDir: dir, pluginRoot: noGitPluginRoot({ history: false }), known: known(dir), layer: OK });
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.match(rows[0].warning, /could not be verified as Sterling's generated text/);
  assert.doesNotMatch(rows[0].warning, /holds text that is not/);
  assert.equal(read(dir, 'CLAUDE.md'), older);
});

// ---- syncLayer: the update-time pass (disk state is the evidence) ----

test('syncLayer keeps a CLAUDE.md with a rule added on its project-name heading line, and a GEMINI.md naming an unknown root', () => {
  const dir = project({ agents: validAgents() });
  const claude = claudeRender().replace('# CLAUDE.md — demo (Sterling layer)', '# CLAUDE.md — demo. Always use tabs. (Sterling layer)');
  const gemini = agyRender('demo', '/opt/elsewhere');
  writeFileSync(join(dir, 'CLAUDE.md'), claude);
  writeFileSync(join(dir, 'GEMINI.md'), gemini);
  syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(read(dir, 'CLAUDE.md'), claude);
  assert.equal(read(dir, 'GEMINI.md'), gemini);
});

test('syncLayer never removes a symbolic link named CLAUDE.md, even to a pure render', () => {
  const dir = project({ agents: validAgents() });
  const target = join(tmp(), 'pure.md');
  writeFileSync(target, claudeRender());
  symlinkSync(target, join(dir, 'CLAUDE.md'));
  syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.ok(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink());
});

test('syncLayer keeps a pure CLAUDE.md when the project has no AGENTS.md', () => {
  const dir = project();
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
  assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
});

test('syncLayer on broken markers leaves AGENTS.md untouched and keeps a pure CLAUDE.md', () => {
  const broken = `# P\n\n${readLayerSection(repo).split('\n')[0]}\n\nno end\n`;
  const dir = project({ agents: broken });
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(read(dir, 'AGENTS.md'), broken);
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
});

test('syncLayer refuses an AGENTS.md that would pass agy\'s 24,000-byte cap: nothing written, nothing removed', () => {
  const rule = '- **Project rule.** A long project rule that this project keeps in its AGENTS.md file.\n';
  const agents = `# P\n\n${rule.repeat(Math.ceil(20_412 / bytes(rule)))}`.slice(0, 20_412);
  const dir = project({ agents });
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(read(dir, 'AGENTS.md'), agents, 'AGENTS.md unchanged');
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender(), 'CLAUDE.md kept');
});

test('syncLayer reports refusals and kept files with the prefixes /sterling:update relays, and counts the refusal', () => {
  const rule = '- **Project rule.** A long project rule that this project keeps in its AGENTS.md file.\n';
  const dir = project({ agents: `# P\n\n${rule.repeat(260)}` });
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const { lines, refused } = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(refused, 1);
  assert.ok(lines.some((l) => /^✗ Sterling layer REFUSED: AGENTS\.md would be [\d,]+ bytes .*over agy's 24,000-byte cap/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^⚠ Sterling layer: CLAUDE\.md was not checked for removal/.test(l)), lines.join('\n'));
});

test('syncLayer regenerates the section, preserves project rules outside the markers byte for byte and retires a pure CLAUDE.md', () => {
  const section = readLayerSection(repo);
  const head = '# P\n\n- **Mine.** Keep me.  \n\n';
  const tail = '\n\n- **Also mine.**\n\n\n';
  const dir = project({ agents: `${head}${section.replace('Sterling layer (generated)', 'STALE')}${tail}` });
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const first = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(first.refused, 0);
  assert.equal(read(dir, 'AGENTS.md'), `${head}${section}${tail}`);
  assert.ok(first.lines.includes('Sterling layer: AGENTS.md regenerated'), first.lines.join('\n'));
  assert.ok(first.lines.some((l) => /^Sterling layer: CLAUDE\.md removed — /.test(l)), first.lines.join('\n'));
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.ok(syncLayer({ projectDir: dir, pluginRoot: repo }).lines.includes('Sterling layer: AGENTS.md up to date'));
});

// ---- review loop 2 of #329 ----

const repoHistory = () => JSON.parse(readFileSync(join(repo, 'bin', 'host-file-history.json'), 'utf8'));
const gitShow = (sha) => spawnSync('git', ['show', `${sha}:templates/target-claude-md.md`], { cwd: repo, encoding: 'utf8' }).stdout;
const templateShas = () => spawnSync('git', ['log', '--format=%H', '--', 'templates/target-claude-md.md'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

test('a pre-split CLAUDE.md render whose project-fact tokens were left unfilled is never pure: its writer filled values Sterling cannot reproduce', () => {
  const sha = templateShas().find((h) => /\{\{STACK_TAGS\}\}/.test(gitShow(h)) && gitShow(h).includes('{{CONVENTIONS_SECTION}}'));
  assert.ok(sha, 'fixture: a pre-split template revision');
  const text = renderClaudeText(gitShow(sha), 't').replaceAll('{{PROJECT_NAME}}', 'demo').replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
  assert.match(text, /\{\{STACK_TAGS\}\}/, 'fixture: the project facts are literal placeholders');
  const dir = project();
  assert.equal(classifyHostFile(text, 'claude', { pluginRoot: repo, known: known(dir) }).pure, false);
  writeFileSync(join(dir, 'CLAUDE.md'), text);
  const { rows } = retireHostFiles({ projectDir: dir, pluginRoot: repo, known: known(dir), layer: OK });
  assert.deepEqual(rows.map((r) => r.status), ['kept']);
  assert.equal(read(dir, 'CLAUDE.md'), text);
});

test('the shipped history holds no render with a token its writer did not fill', () => {
  const h = repoHistory();
  const texts = (host) => h.renders[host].map((t) => t.map((i) => h.lines[i]).join('\n'));
  for (const t of texts('claude')) assert.deepEqual([...new Set(t.match(/\{\{[A-Z_]+\}\}/g) ?? [])].filter((k) => k !== '{{PROJECT_NAME}}'), []);
  for (const t of texts('agy')) assert.deepEqual([...new Set(t.match(/\{\{[A-Z_]+\}\}/g) ?? [])].filter((k) => k !== '{{PROJECT_NAME}}' && k !== '{{STERLING_ROOT}}'), []);
});

test('an older render for a project named Sterling or project is recognised: values are filled at the token positions, never substituted back into the file', () => {
  const withHistory = noGitPluginRoot();
  for (const name of ['Sterling', 'project', 'CLAUDE']) {
    const dir = project();
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: name }));
    const older = claudeRender(name, olderTemplate());
    assert.deepEqual(classifyHostFile(older, 'claude', { pluginRoot: withHistory, known: known(dir) }), { pure: true }, name);
  }
});

test('markers inside an HTML comment or a <pre> block are refused, never treated as the live section', () => {
  const section = readLayerSection(repo);
  for (const text of [
    `# P\n\n<!--\nexample:\n${section}\n-->\n\n- **Mine.**\n`,
    `# P\n\n<pre>\n${section}\n</pre>\n`,
    `# P\n\n<!-- an unclosed comment\n\n- **Mine.**\n`,
  ]) assert.throws(() => applyLayer(text, section), LayerMarkerError, text.slice(0, 40));
  const inline = `# P\n\n<!-- one-line comment -->\n<code>x</code>\n`;
  assert.equal(applyLayer(inline, section), `${inline}\n${section}\n`, 'a closed one-line comment or element is ordinary text');
});

test('syncLayer leaves an AGENTS.md whose markers sit in an HTML comment byte-identical and keeps a pure CLAUDE.md', () => {
  const agents = `# P\n\n<!--\n${readLayerSection(repo)}\n-->\n`;
  const dir = project({ agents });
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const { refused } = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(refused, 1);
  assert.equal(read(dir, 'AGENTS.md'), agents);
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
});

test('syncLayer refuses an AGENTS.md with bytes that are not valid UTF-8: every byte kept, nothing removed', () => {
  const dir = project();
  const raw = Buffer.concat([Buffer.from('# P\n\nLatin-1 caf'), Buffer.from([0xe9]), Buffer.from('\n')]);
  writeFileSync(join(dir, 'AGENTS.md'), raw);
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const { refused, lines } = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(refused, 1, lines.join('\n'));
  assert.ok(readFileSync(join(dir, 'AGENTS.md')).equals(raw), 'AGENTS.md bytes unchanged');
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
});

test('syncLayer never follows or replaces a symlinked AGENTS.md: link, target and a pure CLAUDE.md are all left as they were', () => {
  const dir = project();
  writeFileSync(join(dir, 'CLAUDE.md'), claudeRender());
  const outside = join(tmp(), 'AGENTS.md');
  writeFileSync(outside, '# Shared rules\n');
  symlinkSync(outside, join(dir, 'AGENTS.md'));
  const { refused } = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(refused, 1);
  assert.ok(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink());
  assert.equal(readlinkSync(join(dir, 'AGENTS.md')), outside);
  assert.equal(readFileSync(outside, 'utf8'), '# Shared rules\n');
  assert.equal(read(dir, 'CLAUDE.md'), claudeRender());
});

test('syncLayer refuses an AGENTS.md hard-linked to another file, leaving both untouched', () => {
  const dir = project();
  const other = join(tmp(), 'other.md');
  writeFileSync(other, '# Other\n');
  linkSync(other, join(dir, 'AGENTS.md'));
  const { refused } = syncLayer({ projectDir: dir, pluginRoot: repo });
  assert.equal(refused, 1);
  assert.equal(readFileSync(other, 'utf8'), '# Other\n');
});

test('plannedAgentsMdRefusal judges the whole planned file with the layer in: a text that fits alone but not with the layer is refused', () => {
  const section = readLayerSection(repo);
  const filler = `# P\n\n${'- **Rule.** Project text.\n'.repeat(700)}`;
  assert.ok(bytes(filler) < AGENTS_MD_AGY_CAP_BYTES && bytes(applyLayer(filler, section)) > AGENTS_MD_AGY_CAP_BYTES, 'fixture');
  assert.match(plannedAgentsMdRefusal(filler, section), /over agy's 24,000-byte cap/);
  assert.equal(plannedAgentsMdRefusal('# P\n', section), null);
});
