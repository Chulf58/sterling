// What OpenCode reads from Sterling's commands, skills and agent templates holds no
// Claude Code surface it cannot use (board item 57187b23, audit finding f2ba68c2;
// decision sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code):
// no `.claude/` path and no `Bash` tool outside a claude-only block, and what
// OpenCode cannot run is disclosed with its equivalent named.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cfg;
let fences;
before(async () => {
  cfg = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'config.mjs')).href);
  fences = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'agent-fences.mjs')).href);
});

// Surfaces a rendered OpenCode body must not name: the .claude/ directory (OpenCode
// installs under .opencode/) and the Bash tool (OpenCode's tool is `shell`).
const CLAUDE_SURFACES = [['.claude/', /\.claude\//], ['Bash', /\bBash\b/]];

function agentBodies() {
  const dir = join(repo, 'agent-templates');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const rendered = fences.renderOpenCodeFullText(text, `agent-templates/${f}`);
    return { label: `agent-templates/${f}`, body: rendered.replace(/^---\n[\s\S]*?\n---\n/, '') };
  });
}

// Commands and skills as OpenCode receives them, rendered against a neutral root: the
// resolved root is substituted for CLAUDE_PLUGIN_ROOT, and a clone under .claude/ would
// put that string into every body.
function registrationBodies() {
  const out = [];
  const add = (label, path) => {
    const { meta, body } = cfg.splitFrontmatter(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), label);
    out.push({ label, body: `${cfg.hostMapText(meta.description, '/opt/sterling', label)}\n${cfg.hostMapText(body, '/opt/sterling', label)}` });
  };
  for (const f of readdirSync(join(repo, 'commands')).filter((n) => n.endsWith('.md')).sort()) add(`commands/${f}`, join(repo, 'commands', f));
  for (const d of readdirSync(join(repo, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory())) add(`skills/${d.name}`, join(repo, 'skills', d.name, 'SKILL.md'));
  return out;
}

test('no rendered OpenCode command, skill or agent body names .claude/ or the Bash tool', () => {
  const items = [...registrationBodies(), ...agentBodies()];
  const hits = [];
  for (const { label, body } of items) {
    body.split('\n').forEach((line, i) => {
      for (const [name, re] of CLAUDE_SURFACES) if (re.test(line)) hits.push(`${label}:${i + 1} ${name}: ${line.slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the OpenCode conductor discloses what OpenCode cannot run, each with its equivalent named', () => {
  const conductor = agentBodies().find((a) => a.label === 'agent-templates/conductor.md').body;
  assert.doesNotMatch(conductor, /48903a6f|sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin/, 'the superseded gauge ruling is not cited');
  assert.match(conductor, /sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code/, 'cites the ruling that supersedes it');
  assert.match(conductor, /no context-pressure gauge/i);
  assert.match(conductor, /no stop block[\s\S]*STERLING NOTICE/i, 'H10 stop block: notices and queue items instead');
  assert.match(conductor, /ExitPlanMode[\s\S]*bin\/plan-lock\.mjs[\s\S]*--plan/, 'H31 plan lock: the manual script');
  assert.match(conductor, /TaskStop[\s\S]*no OpenCode equivalent/i, 'TaskStop has none, said plainly');
});

test('the host map translates the .claude/agents install path to the OpenCode one', () => {
  assert.equal(cfg.hostMapText('installed as `.claude/agents/reviewer.md`', '/r', 'x'), 'installed as `.opencode/agents/sterling/reviewer.md`');
});
