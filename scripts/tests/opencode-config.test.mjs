// The OpenCode server plugin's registration seam (packages/opencode-plugin/src/config.mjs):
// every Sterling command and skill registered with host-correct bodies, and the
// `sterling` MCP entry injected from the loaded copy (decision
// sterling-opencode-plugin-injects-its-own-mcp-entry). Driven through a stubbed
// plugin context whose editors behave as OpenCode 2.0.21's: a transform callback
// runs against a fresh base on every reload.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';

let cfg;
before(async () => {
  cfg = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'config.mjs')).href);
});

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-occfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return dir;
}

// Editors with OpenCode 2.0.21's shape. `base` seeds each run (the config-file state).
function stubCtx(directory, { mcpBase = {} } = {}) {
  const callbacks = { command: [], skill: [], mcp: [] };
  const prompts = [];
  const run = () => {
    const commands = new Map();
    const skills = new Map([['opencode', { id: 'opencode', name: 'OpenCode', path: '/builtin/opencode.md', content: 'x' }]]);
    const mcp = new Map(Object.entries(structuredClone(mcpBase)));
    for (const cb of callbacks.command) cb({ add: (d) => commands.set(d.name, d) });
    for (const cb of callbacks.skill) {
      cb({
        list: () => [...skills.values()],
        get: (id) => skills.get(id),
        add: (s) => skills.set(s.id, s),
        update: (id, f) => f(skills.get(id)),
        remove: (id) => skills.delete(id),
      });
    }
    for (const cb of callbacks.mcp) {
      cb({
        list: () => [...mcp.entries()],
        get: (n) => mcp.get(n),
        set: (n, c) => mcp.set(n, c),
        update: (n, f) => f(mcp.get(n)),
        remove: (n) => mcp.delete(n),
      });
    }
    return { commands, skills, mcp };
  };
  const domain = (k) => ({ transform: async (cb) => (callbacks[k].push(cb), { dispose: async () => {} }) });
  return {
    location: { directory },
    command: domain('command'),
    skill: domain('skill'),
    mcp: domain('mcp'),
    session: { prompt: async (input) => (prompts.push(input), { id: 'msg_1', type: 'user' }) },
    run,
    prompts,
  };
}

const commandFiles = () => readdirSync(join(repo, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
const skillDirs = () => readdirSync(join(repo, 'skills')).filter((d) => existsSync(join(repo, 'skills', d, 'SKILL.md'))).sort();
const noticesOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'opencode-notices.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

test('every commands/*.md registers as sterling:<name> and every SKILL.md as a skill, with no Claude-only phrase left', async (t) => {
  const project = tempProject(t);
  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  const { commands, skills } = ctx.run();
  assert.deepEqual([...commands.keys()].sort(), commandFiles().map((n) => `sterling:${n}`));
  assert.deepEqual([...skills.keys()].filter((k) => k !== 'opencode').sort(), skillDirs().map((n) => `sterling:${n}`));
  assert.ok(skills.has('opencode'), 'built-in skills are kept');
  for (const s of skills.values()) {
    if (s.id === 'opencode') continue;
    assert.equal(s.name, s.id);
    assert.ok(s.description, `${s.id} has a description`);
    assert.equal(s.path, join(repo, 'skills', s.id.slice('sterling:'.length), 'SKILL.md'), 'path is the SKILL.md, so relative paths resolve beside it');
    assert.doesNotMatch(s.content, /^---\n/, `${s.id}: content is the body without frontmatter`);
    assert.doesNotMatch(s.content + s.description, /CLAUDE_PLUGIN_ROOT|AskUserQuestion|READY TO CLEAR/, s.id);
  }
  for (const c of commands.values()) assert.ok(c.description, `${c.name} has a description`);
  assert.deepEqual(noticesOf(project), [], 'every real source renders: no failure notice');
});

test('a command puts its rendered body into the session through session.prompt, arguments appended', async (t) => {
  const project = tempProject(t);
  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  const { commands } = ctx.run();

  await commands.get('sterling:projects').execute({ sessionID: 'ses_1', prompt: { text: '' }, delivery: 'steer' });
  const [p] = ctx.prompts;
  assert.equal(p.sessionID, 'ses_1');
  assert.equal(p.delivery, 'steer');
  assert.ok(p.text.includes(`node "${repo}/bin/list-projects.mjs"`), 'CLAUDE_PLUGIN_ROOT is the resolved root');
  assert.doesNotMatch(p.text, /CLAUDE_PLUGIN_ROOT|^---|ARGUMENTS:/m);

  await commands.get('sterling:task').execute({ sessionID: 'ses_2', prompt: { text: '  fix the login page  ' }, delivery: 'queue' });
  assert.match(ctx.prompts[1].text, /\n\nARGUMENTS: fix the login page$/);
  assert.equal(ctx.prompts[1].delivery, 'queue');
});

test('AskUserQuestion maps to the question tool, readably, in bodies and descriptions', async (t) => {
  const project = tempProject(t);
  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  const { commands, skills } = ctx.run();
  await commands.get('sterling:init').execute({ sessionID: 's', prompt: { text: '' }, delivery: 'steer' });
  assert.match(ctx.prompts[0].text, /ask ONE `question` tool form, header "Mode"/);
  assert.match(skills.get('sterling:grill').description, /one `question` tool form at a time/);
  assert.match(skills.get('sterling:decision-records').content, /through a `question` tool form/);
  assert.match(skills.get('sterling:pr-review-loop').content, /through the \*\*`question`\*\* tool/);

  assert.equal(cfg.hostMapText('Say READY TO CLEAR. Ask through the AskUserQuestion tool.', '/r', 'x'), "Say READY FOR NEW SESSION. Ask through OpenCode's `question` tool.");
});

test('host fences: an opencode-only block replaces its paired claude-only block', () => {
  const text = 'a\n<!-- claude-only -->\nRun /clear now.\n<!-- /claude-only -->\n<!-- opencode-only -->\nStart a new session with /new.\n<!-- /opencode-only -->\nb\n';
  assert.equal(cfg.hostMapText(text, '/r', 'fx'), 'a\nStart a new session with /new.\nb\n');
  assert.throws(() => cfg.hostMapText('<!-- claude-only -->\nx\n<!-- /claude-only -->\nb\n', '/r', 'fx'), /fences invalid in fx/, 'an unpaired claude-only block refuses');
});

test('a body left with a Claude-only phrase fails loudly for that one item; the rest register', async (t) => {
  const project = tempProject(t);
  const root = mkdtempSync(join(tmpdir(), 'sterling-occfg-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'commands'));
  mkdirSync(join(root, 'skills', 'good'), { recursive: true });
  mkdirSync(join(root, 'skills', 'bad'), { recursive: true });
  writeFileSync(join(root, 'commands', 'ok.md'), '---\ndescription: fine\n---\n\nRun `node "${CLAUDE_PLUGIN_ROOT}/bin/x.mjs"`.\n');
  writeFileSync(join(root, 'commands', 'leaky.md'), '---\ndescription: leaky\n---\n\nRun `node "$CLAUDE_PLUGIN_ROOT/bin/x.mjs"`, then /clear.\n');
  writeFileSync(join(root, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: good skill\n---\n\nBody.\n');
  writeFileSync(join(root, 'skills', 'bad', 'SKILL.md'), '---\nname: bad\n---\n\nNo description.\n');

  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: root, now: () => NOW })(ctx);
  const { commands, skills } = ctx.run();
  assert.deepEqual([...commands.keys()], ['sterling:ok']);
  assert.deepEqual([...skills.keys()].sort(), ['opencode', 'sterling:good']);
  await commands.get('sterling:ok').execute({ sessionID: 's', prompt: { text: '' }, delivery: 'steer' });
  assert.equal(ctx.prompts[0].text, `Run \`node "${root}/bin/x.mjs"\`.`);

  const notices = noticesOf(project).map((n) => n.text);
  assert.equal(notices.length, 2);
  assert.match(notices.find((n) => n.includes('/sterling:leaky')), /not registered on OpenCode \(commands\/leaky\.md has unmapped Claude-only phrase\(s\) for OpenCode: CLAUDE_PLUGIN_ROOT, \/clear\)/);
  assert.match(notices.find((n) => n.includes('sterling:bad')), /skills\/bad\/SKILL\.md: frontmatter has no description/);
  assert.match(readFileSync(join(project, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /config: command sterling:leaky not registered/);
});

test('the sterling MCP entry points at this copy and replaces a project entry, logging the replacement', async (t) => {
  const project = tempProject(t);
  const want = { type: 'local', command: ['node', '--disable-warning=ExperimentalWarning', join(repo, 'mcp', 'sterling-mcp.mjs'), '--store', join(project, '.sterling', 'sterling.db')] };
  assert.deepEqual(cfg.mcpEntry(repo, project), want);

  const fresh = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(fresh);
  assert.deepEqual(fresh.run().mcp.get('sterling'), want);

  const projectEntry = { type: 'local', command: ['node', '/home/u/.sterling/opencode/sterling-mcp.mjs', '--store', '.sterling/sterling.db'], timeout: {} };
  const ctx = stubCtx(project, { mcpBase: { sterling: projectEntry, other: { type: 'remote', url: 'https://x' } } });
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  const first = ctx.run();
  assert.deepEqual(first.mcp.get('sterling'), want);
  assert.deepEqual(first.mcp.get('other'), { type: 'remote', url: 'https://x' }, 'other servers are untouched');
  ctx.run();
  const log = readFileSync(join(project, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8');
  assert.equal(log.match(/sterling MCP entry from the project config/g).length, 1, 'logged once across reloads');
});

test('transform callbacks re-run on reload and give the same registrations', async (t) => {
  const project = tempProject(t);
  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  const a = ctx.run();
  const b = ctx.run();
  assert.deepEqual([...a.commands.keys()], [...b.commands.keys()]);
  assert.deepEqual([...a.skills.values()], [...b.skills.values()]);
  assert.deepEqual(a.mcp.get('sterling'), b.mcp.get('sterling'));
});

// Claude Code reads commands and skills raw, fences and all, so its model sees every
// opencode-only block. Each one opens with an explicit "On OpenCode," so that model
// cannot take the block as its own instruction (coordinator ruling, 2026-10-02).
test('every opencode-only block in a raw-read command or skill opens with "On OpenCode,"', () => {
  const files = [...commandFiles().map((n) => join('commands', `${n}.md`)), ...skillDirs().map((d) => join('skills', d, 'SKILL.md'))];
  let blocks = 0;
  for (const rel of files) {
    const lines = readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (line !== '<!-- opencode-only -->') return;
      blocks++;
      const first = lines.slice(i + 1).find((l) => l.trim() !== '');
      assert.ok(first?.startsWith('On OpenCode,'), `${rel}:${i + 2}: an opencode-only block opens with "On OpenCode,", got ${JSON.stringify(first)}`);
    });
  }
  assert.ok(blocks >= 1, 'the check saw at least one block (dashboard.md has one)');
});

test('dashboard.md: the OpenCode render names the TUI plugin and no tmux or launcher; the Claude render is the unfenced text', async (t) => {
  const { renderClaudeText } = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'agent-fences.mjs')).href);
  const source = readFileSync(join(repo, 'commands', 'dashboard.md'), 'utf8');
  assert.match(source, /^<!-- claude-only -->$/m, 'the Claude Code text is fenced');
  const claude = renderClaudeText(source, 'commands/dashboard.md');
  const unfenced = source.replace(/<!-- opencode-only -->\n[\s\S]*?<!-- \/opencode-only -->\n/, '').replace(/^<!-- \/?claude-only -->\n/gm, '');
  assert.equal(claude, unfenced, 'byte-identical to the source without the fences');
  assert.doesNotMatch(claude, /<!--|OpenCode|<leader>k/, 'no marker or OpenCode text reaches the Claude render');
  assert.match(claude, /`\.\/sterling-launch\.sh tui`/);

  const project = tempProject(t);
  const ctx = stubCtx(project);
  await cfg.createConfigHandler({ sterlingRoot: repo, now: () => NOW })(ctx);
  await ctx.run().commands.get('sterling:dashboard').execute({ sessionID: 's', prompt: { text: '' }, delivery: 'steer' });
  const oc = ctx.prompts[0].text;
  assert.doesNotMatch(oc, /tmux|launcher|sterling-launch|\.bat\b|split pane|<!--/i);
  assert.match(oc, /`<leader>k` \(ctrl\+x then k by default\)/);
  assert.match(oc, /`\/sterling`/);
  // The fix for a missing panel depends on the host that installed the copy (decision 66d04413):
  // the npm copy updates through opencode plugin update, a Claude Code copy through Claude Code.
  assert.match(oc, /`opencode plugin add`[^.]*`opencode plugin update @chulf58\/sterling`/);
  assert.match(oc, /Claude Code plugin cache or a clone[^.]*`\/sterling:update`[^.]*in Claude Code/);
  assert.doesNotMatch(oc, /not loaded: tell the user to run `\/sterling:update`/, 'the route is not Claude Code for every copy');
});
