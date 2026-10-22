// The OpenCode Plan agent (GitHub #76 part 2, board 5a20d689): Sterling's
// agent-templates/plan.md installed to .opencode/agents/plan.md, where it merges
// onto OpenCode's built-in plan (finding
// how-does-opencode-v2-override-its-built-in-plan-agent-and-ho). Pinned here: the
// nested permission rendering, the registry's host and destination checks, that the
// Claude install never sees the template, and the installer's ownership refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupOpenCode } from '../lib/opencode-install.mjs';
import { permissionLines } from '../lib/opencode-agents.mjs';
import { loadRegistry, claudeAgentEntries, installAgents, checkRegistryConsistency } from '../lib/agent-distribution.mjs';
import { parseConfig } from '@sterling/schemas';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OC = () => ({ installed: true, version: '2.0.23', major: 2 });
const PLAN_REL = '.opencode/agents/plan.md';
const fwd = (p) => p.replaceAll('\\', '/');

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function project({ handoff } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-plan-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby', ...(handoff === undefined ? {} : { handoff: { enabled: handoff } }) }));
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

const run = (dir, home) => setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: OC });
const rowOf = (r, item) => r.rows.find((x) => x.item === item);

test('permissionLines renders an ordered pattern map as a nested block, each pattern a JSON string, in key order', () => {
  const lines = permissionLines({ edit: { '*': 'deny', '/p/.sterling/plans/*': 'allow' }, webfetch: 'deny', bash: { '*': 'deny', 'node "/x" --plan *': 'allow' } }, 'probe.md');
  assert.deepEqual(lines, [
    'permission:',
    '  edit:',
    '    "*": deny',
    '    "/p/.sterling/plans/*": allow',
    '  webfetch: deny',
    '  bash:',
    '    "*": deny',
    '    "node \\"/x\\" --plan *": allow',
  ]);
  for (const bad of [{ edit: {} }, { edit: { '*': 'maybe' } }, { edit: { 'a\nb': 'deny' } }, { edit: ['deny'] }, { shell: 'deny' }]) {
    assert.throws(() => permissionLines(bad, 'probe.md'), /opencode permission for probe\.md/, JSON.stringify(bad));
  }
});

test('the registry declares plan as OpenCode-only with its destination, and the Claude install never sees it', () => {
  const registry = loadRegistry(join(repoRoot, 'agent-templates', 'registry.json'));
  const plan = registry.agents.find((a) => a.name === 'plan');
  assert.deepEqual(plan.hosts, ['opencode']);
  assert.equal(plan.opencode_full.path, PLAN_REL);
  assert.equal(plan.opencode_full.mode, 'primary');
  assert.equal(plan.opencode, undefined, 'no portable copy: it would be written to the same path');
  const bashKeys = Object.keys(plan.opencode_full.permission.bash);
  assert.equal(bashKeys[0], '*');
  assert.deepEqual(bashKeys.slice(1).filter((k) => k.includes('*')), [], 'every allowed plan command is an exact literal');
  assert.ok(!claudeAgentEntries(registry).some((a) => a.name === 'plan'));
  assert.deepEqual(checkRegistryConsistency({ templatesDir: join(repoRoot, 'agent-templates'), registryPath: join(repoRoot, 'agent-templates', 'registry.json') }), []);
  const target = mkdtempSync(join(tmpdir(), 'claude-agents-'));
  const { report } = installAgents({ templatesDir: join(repoRoot, 'agent-templates'), registryPath: join(repoRoot, 'agent-templates', 'registry.json'), targetAgentsDir: target, pluginVersion: '0.0.0-test', now: '2026-10-11T00:00:00.000Z', config: parseConfig(JSON.parse(readFileSync(join(repoRoot, 'templates', 'default-config.json'), 'utf8'))) });
  assert.ok(!report.some((r) => r.name === 'plan'), 'no report row for plan');
  assert.ok(!existsSync(join(target, 'plan.md')), '.claude/agents/plan.md is never written');
  assert.ok(readdirSync(target).includes('conductor.md'), 'the Claude roster still installs');
  rmSync(target, { recursive: true, force: true });
});

test('loadRegistry refuses a host-limited entry with no destination, a misplaced destination, and a portable copy beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  const write = (entry) => {
    const p = join(dir, 'registry.json');
    writeFileSync(p, JSON.stringify({ version: 1, agents: [{ name: 'plan', file: 'plan.md', ...entry }] }));
    return p;
  };
  const full = { path: PLAN_REL, mode: 'primary' };
  const cases = [
    [{ hosts: ['opencode'] }, /not installed on claude must declare opencode_full/],
    [{ hosts: [] }, /hosts must be a non-empty list/],
    [{ hosts: ['opencode', 'opencode'], opencode_full: full }, /distinct hosts/],
    [{ hosts: ['vscode'], opencode_full: full }, /hosts must be/],
    [{ hosts: ['opencode'], opencode_full: { ...full, path: '.opencode/agents/sterling/plan.md' } }, /opencode_full\.path must be '\.opencode\/agents\/plan\.md'/],
    [{ hosts: ['opencode'], opencode_full: { ...full, path: '.opencode/agents/other.md' } }, /opencode_full\.path must be/],
    [{ hosts: ['opencode'], opencode_full: { ...full, mode: 'all' } }, /opencode_full\.mode must be one of primary, subagent/],
    [{ hosts: ['opencode'], opencode_full: { ...full, model: 'x' } }, /unknown key 'model'/],
    [{ hosts: ['claude'], opencode_full: full }, /opencode_full needs hosts to include opencode/],
    [{ opencode_full: full }, /opencode_full\.mode primary is for an OpenCode-only agent/],
    [{ hosts: ['claude', 'opencode'], opencode_full: full }, /opencode_full\.mode primary is for an OpenCode-only agent/],
    [{ hosts: ['opencode'], opencode_full: full, opencode: {} }, /both write \.opencode\/agents\/plan\.md/],
    [{ hosts: ['opencode'], opencode_full: { ...full, permission: { bash: { '*': 'sometimes' } } } }, /'sometimes' is not one of allow, ask, deny/],
  ];
  for (const [entry, re] of cases) assert.throws(() => loadRegistry(write(entry)), re, JSON.stringify(entry));
  assert.doesNotThrow(() => loadRegistry(write({ hosts: ['opencode'], opencode_full: full })));
  assert.doesNotThrow(() => loadRegistry(write({ opencode_full: { ...full, mode: 'subagent' } })));
  rmSync(dir, { recursive: true, force: true });
});

test('install writes .opencode/agents/plan.md: primary, read-only permissions with absolute paths, store writes denied, excluded from git; a rerun matches', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const dir = project({ handoff: true });
  const r = run(dir, home);
  assert.equal(rowOf(r, PLAN_REL)?.status, 'created');
  const text = readFileSync(join(dir, PLAN_REL), 'utf8');
  const P = fwd(dir);
  const S = fwd(repoRoot);
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n');
  assert.match(fm[0], /^description: Sterling's planning agent for OpenCode\. Plans only, never implements\./);
  assert.deepEqual(fm.slice(1, 24), [
    'mode: primary',
    'permission:',
    '  edit:',
    '    "*": deny',
    `    "${P}/.sterling/plans/*": allow`,
    '  task:',
    '    "*": deny',
    '    "sterling/scout": allow',
    '    "sterling/researcher": allow',
    '    "sterling/reviewer": allow',
    '    "sterling/sparring": allow',
    '    "sterling/implementor": deny',
    '  bash:',
    '    "*": deny',
    `    "node ${S}/bin/plan-lock.mjs --bind-pending": allow`,
    `    "node ${S}/bin/plan-lock.mjs --bind-pending --force": allow`,
    `    "node ${S}/bin/plan-lock.mjs --show": allow`,
    `    "mkdir -p ${P}/.sterling/plans": allow`,
    '    "git status": allow',
    '    "git diff --stat": allow',
    '    "git log --oneline -20": allow',
    '  sterling_knowledge_line_ref_fix: deny',
    '  sterling_knowledge_create: deny',
  ]);
  assert.ok(fm.includes('  sterling_board_add: deny'));
  assert.ok(!fm.some((l) => /^model:/.test(l)), 'no model pin: the plan agent runs on the model the user picks');
  // the body runs exactly the commands the rules allow
  assert.ok(text.includes(`node ${S}/bin/plan-lock.mjs --bind-pending\``));
  assert.ok(text.includes(`node ${S}/bin/plan-lock.mjs --bind-pending --force\``));
  assert.doesNotMatch(text, /plan-lock\.mjs --plan /, 'the body never tells the agent to pass a path');
  assert.ok(text.includes(`node ${S}/bin/plan-lock.mjs --show`));
  assert.ok(text.includes(`mkdir -p ${P}/.sterling/plans`));
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, 'no install token survives');
  assert.match(text, /^<!-- sterling-full renderer=opencode-full\/1 template=plan /m);
  // per-user: kept out of git in a project whose portable agents are committed
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/agents\/plan\.md$/m);
  assert.deepEqual(git(dir, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean), []);
  // the per-agent store guard covers the overridden built-in too
  assert.ok(JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent.plan);
  // EXACT LITERALS ONLY (anti-pattern
  // an-opencode-bash-permission-with-a-trailing-cannot-be-made-s): the shell runs
  // $(...), redirects and separators before a script sees argv, so a `*` in an
  // allow rule admits side effects no argument check can refuse. The leading
  // deny-all is the one wildcard.
  const bashStart = fm.indexOf('  bash:');
  const bashRules = [];
  for (let i = bashStart + 1; i < fm.length && fm[i].startsWith('    '); i++) bashRules.push(fm[i]);
  assert.equal(bashRules[0], '    "*": deny');
  assert.ok(bashRules.length > 1);
  for (const rule of bashRules.slice(1)) assert.ok(!rule.includes('*'), `bash rule carries a wildcard: ${rule}`);
  const again = run(dir, home);
  assert.equal(rowOf(again, PLAN_REL)?.status, 'matches');
  assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), text);
});

test('a foreign or locally edited plan.md is refused loudly and left byte-identical; a tracked one is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const dir = project();
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  const mine = '---\ndescription: my plan\nmode: primary\n---\nmine\n';
  writeFileSync(join(dir, PLAN_REL), mine);
  const foreign = rowOf(run(dir, home), PLAN_REL);
  assert.equal(foreign.status, 'refused');
  assert.match(foreign.instruction, /carries no Sterling header/);
  assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), mine);

  rmSync(join(dir, PLAN_REL));
  run(dir, home);
  const edited = `${readFileSync(join(dir, PLAN_REL), 'utf8')}\nmy edit\n`;
  writeFileSync(join(dir, PLAN_REL), edited);
  const row = rowOf(run(dir, home), PLAN_REL);
  assert.equal(row.status, 'refused');
  assert.match(row.instruction, /was edited after Sterling wrote it/);
  assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), edited);

  writeFileSync(join(dir, PLAN_REL), mine);
  git(dir, ['add', '-f', PLAN_REL]);
  git(dir, ['commit', '-qm', 'plan']);
  const tracked = rowOf(run(dir, home), PLAN_REL);
  assert.equal(tracked.status, 'refused');
  assert.match(tracked.instruction, /git rm --cached \.opencode\/agents\/plan\.md/);
  assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), mine);
});

test('a project path a shell rule cannot match literally skips plan.md alone (not a refusal); the roster still installs', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const parent = mkdtempSync(join(tmpdir(), 'oc plan space-'));
  const dir = mkdtempSync(join(parent, 'p-'));
  git(dir, ['init', '-q']);
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const r = run(dir, home);
  const row = rowOf(r, PLAN_REL);
  // Was a refusal that made sync-agents exit 2 (GitHub #85); user-ruled 2026-10-12, decision
  // existing-unsafe-path-project-skips-opencode-plan-agent-not-refuse: a skip, no `refused`.
  assert.equal(row.status, 'skipped');
  assert.ok(!row.refused);
  assert.match(row.detail, /the Plan agent is not installed at this path: it needs the project path .* in shell permission rules/);
  assert.match(row.detail, /rename the folder/);
  assert.ok(!existsSync(join(dir, PLAN_REL)));
  assert.equal(rowOf(r, '.opencode/agents/sterling/conductor.md')?.status, 'created');
});
