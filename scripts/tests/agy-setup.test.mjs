// Sterling on Antigravity CLI (agy) project setup (scripts/lib/agy-setup.mjs; decision
// antigravity-cli-agy-sterling-mcp-server-is-declared-per-agen): the generated
// .agents/agents/<name>/agent.md roster, GEMINI.md, the exclude block, the agy install root
// in sterling-roots, the three-host post-update sync, stamp-contract's GEMINI.md pass, and
// init/sync-agents with agy absent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { ProjectRegistry } from '@sterling/store';
import {
  AGY_ROSTER,
  AGY_TOOLS,
  GEMINI_MD_MAX_BYTES,
  agyMcpRoot,
  ensureAgyExcluded,
  formatAgyRows,
  probeAgy,
  renderGeminiMd,
  setupAgy,
} from '../lib/agy-setup.mjs';
import { ROSTER } from '../lib/opencode-install.mjs';
import { installHostOf, newestInstalledSterling, scanInstalledSterling, sterlingInstallRemedy, sterlingUpdateRemedy } from '../lib/sterling-roots.mjs';
import { postUpdateSync, runPostUpdateSteps } from '../lib/post-update-sync.mjs';
import { extractBlock } from '../lib/contract-bullets.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = '/opt/node/bin/node';
const ON = { STERLING_AGY_PROBE: 'ok' };

const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
function gitProject() {
  const dir = tmp('sterling-agy-proj-');
  git(dir, 'init', '-q');
  return dir;
}
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, 'agent.md has a frontmatter block');
  return { fm: load(m[1]), body: m[2] };
}
const READ_ONLY = ['researcher', 'scout', 'reviewer', 'sparring', 'librarian', 'preflight'];
const WRITE_TOOLS = ['write_file', 'edit_file', 'multi_replace_file_content'];

test('the agy roster mirrors the OpenCode roster and names', () => {
  assert.deepEqual([...AGY_ROSTER].sort(), [...ROSTER].sort());
});

test('agent.md per role: agy frontmatter, the shared `sterling` server on execPath with --project ., and STERLING-ROLE as the first body line', () => {
  const dir = gitProject();
  const r = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  assert.equal(r.root, repo, 'a clone bakes its own root');
  for (const name of AGY_ROSTER) {
    const text = readFileSync(join(dir, '.agents', 'agents', name, 'agent.md'), 'utf8');
    const { fm, body } = frontmatter(text);
    assert.equal(fm.name, name);
    assert.equal(fm.model, 'inherit');
    assert.equal(typeof fm.description, 'string');
    assert.equal(fm.mainAgent, name === 'conductor', `${name} mainAgent`);
    assert.equal(fm.subagent, name !== 'conductor', `${name} subagent`);
    assert.deepEqual(fm.tools, AGY_TOOLS[name]);
    assert.deepEqual(fm.mcpServers, [{ name: 'sterling', command: NODE, args: [`${repo}/mcp/sterling-mcp.mjs`, '--project', '.'] }]);
    assert.equal(body.split('\n')[0], `STERLING-ROLE: ${name}`, `${name}: the role marker is the first body line`);
    assert.match(body.split('\n')[1], /^<!-- sterling-agy renderer=agy\/1 template=/);
    assert.doesNotMatch(body, /\{\{[A-Z_]+\}\}/);
    assert.doesNotMatch(body, /<!-- \/?(claude|opencode|agy|sterling|portable)-only -->/);
    if (READ_ONLY.includes(name)) for (const t of WRITE_TOOLS) assert.ok(!fm.tools.includes(t), `${name} must not get ${t}`);
    if (name !== 'conductor') assert.ok(!fm.tools.includes('invoke_subagent'), `${name} cannot dispatch`);
  }
  const conductor = frontmatter(readFileSync(join(dir, '.agents', 'agents', 'conductor', 'agent.md'), 'utf8')).fm;
  for (const t of ['invoke_subagent', 'send_message']) assert.ok(conductor.tools.includes(t), `conductor lists ${t}`);
  assert.deepEqual(AGY_TOOLS.scout.filter((t) => ['run_command', 'search_web'].includes(t)), [], 'scout: no shell, no web (its OpenCode permissions)');
});

test('agent.md ownership: a re-run matches, an edited, a foreign or a tracked file is refused and left as it is', () => {
  const dir = gitProject();
  setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  const again = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  assert.deepEqual(again.rows.filter((r) => r.item.startsWith('.agents/')).map((r) => r.status), AGY_ROSTER.map(() => 'matches'));
  const scout = join(dir, '.agents', 'agents', 'scout', 'agent.md');
  writeFileSync(scout, `${readFileSync(scout, 'utf8')}\nmy edit\n`);
  const foreign = join(dir, '.agents', 'agents', 'reviewer', 'agent.md');
  writeFileSync(foreign, '---\nname: reviewer\n---\nmine\n');
  git(dir, 'add', '-f', '.agents/agents/librarian/agent.md');
  const r = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  const row = (n) => r.rows.find((x) => x.item === `.agents/agents/${n}/agent.md`);
  assert.equal(row('scout').status, 'refused');
  assert.match(row('scout').detail, /edited after Sterling wrote it/);
  assert.equal(row('reviewer').status, 'refused');
  assert.match(row('reviewer').detail, /no Sterling agy header/);
  assert.equal(row('librarian').status, 'refused');
  assert.match(row('librarian').detail, /tracked by git/);
  assert.match(readFileSync(scout, 'utf8'), /my edit/);
  assert.equal(readFileSync(foreign, 'utf8'), '---\nname: reviewer\n---\nmine\n');
});

test('GEMINI.md: the agy render under 24,000 bytes, no @AGENTS.md import, written only when absent', () => {
  const text = renderGeminiMd({ pluginRoot: repo, root: '/x/sterling', projectName: 'demo' });
  assert.ok(Buffer.byteLength(text) <= GEMINI_MD_MAX_BYTES, `${Buffer.byteLength(text)} bytes`);
  assert.doesNotMatch(text, /^@AGENTS\.md/m);
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /# CLAUDE\.md — demo \(Sterling layer\)/);
  assert.match(text, /node "\/x\/sterling\/bin\/rotation-note\.mjs"/);
  const dir = gitProject();
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'demo' }));
  const rowOf = (r) => r.rows.find((x) => x.item === 'GEMINI.md');
  assert.equal(rowOf(setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false })).status, 'created');
  assert.match(readFileSync(join(dir, 'GEMINI.md'), 'utf8'), /— demo \(Sterling layer\)/);
  assert.equal(rowOf(setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false })).status, 'matches');
  writeFileSync(join(dir, 'GEMINI.md'), 'my own\n');
  assert.equal(rowOf(setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false })).status, 'differs');
  assert.equal(readFileSync(join(dir, 'GEMINI.md'), 'utf8'), 'my own\n');
});

test('exclude block: every agy agent dir plus GEMINI.md; a Sterling GEMINI.md that later differs stays listed; a tracked one never is', () => {
  const dir = gitProject();
  setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false });
  const block = () => readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').match(/# >>> sterling agy[^\n]*\n([\s\S]*?)# <<< sterling agy/)[1].trim().split('\n');
  assert.deepEqual(block(), [...AGY_ROSTER.map((n) => `/.agents/agents/${n}/`), '/GEMINI.md']);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all').stdout, '', 'nothing Sterling wrote shows in git status');
  writeFileSync(join(dir, 'GEMINI.md'), 'changed\n');
  setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false });
  assert.ok(block().includes('/GEMINI.md'), 'kept: listed before');
  git(dir, 'add', '-f', 'GEMINI.md');
  setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false });
  assert.ok(!block().includes('/GEMINI.md'), 'a tracked GEMINI.md is the project\'s');
  const plain = gitProject();
  writeFileSync(join(plain, 'GEMINI.md'), 'a user file\n');
  assert.equal(ensureAgyExcluded({ projectDir: plain, gemini: 'keep' }).status, 'created');
  assert.ok(!readFileSync(join(plain, '.git', 'info', 'exclude'), 'utf8').includes('/GEMINI.md'), 'a GEMINI.md Sterling never listed is not hidden');
});

test('agy absent: one loud skip line and nothing written; the disable seam and a bad probe value are loud too', () => {
  const dir = gitProject();
  const r = setupAgy({ projectDir: dir, pluginRoot: repo, env: { STERLING_AGY_PROBE: 'absent' } });
  assert.deepEqual(formatAgyRows(r), ['Antigravity CLI (agy): agy not installed (STERLING_AGY_PROBE=absent) — Sterling on Antigravity CLI SKIPPED: no .agents/agents/, GEMINI.md or exclude block written; install agy, then run /sterling:update']);
  assert.equal(existsSync(join(dir, '.agents')), false);
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
  assert.doesNotMatch(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /sterling agy/);
  assert.match(setupAgy({ projectDir: dir, pluginRoot: repo, env: { STERLING_AGY_SETUP_DISABLE: '1' }, probe: () => assert.fail('probed') }).skipped, /STERLING_AGY_SETUP_DISABLE=1/);
  assert.throws(() => probeAgy({ env: { STERLING_AGY_PROBE: 'yes' } }), /STERLING_AGY_PROBE must be 'ok' or 'absent'/);
  assert.deepEqual(probeAgy({ env: { PATH: tmp('sterling-agy-nobin-') }, home: tmp('sterling-agy-nohome-') }), { installed: false, reason: 'no `agy` on PATH or in ~/.local/bin' });
});

// A Sterling copy at `root` with `version` in every manifest the hosts read.
function copyAt(root, version) {
  for (const rel of ['.claude-plugin/plugin.json', '.antigravity-plugin/plugin.json', 'package.json']) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify({ name: 'sterling', version }));
  }
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'sterling-mcp.mjs'), '');
  return root;
}
const agyCopy = (home) => join(home, '.gemini', 'config', 'plugins', 'sterling');
const claudeCopy = (home, v) => join(home, '.claude', 'plugins', 'cache', 'sterling', 'sterling', v);
const opencodeCopy = (home, v) => join(home, '.cache', 'opencode', 'npm', 'k', String(v.replace(/\./g, '')), 'node_modules', '@chulf58', 'sterling');

test('sterling-roots: the agy root is scanned, ranks below claude-code and opencode at a tie, and has its own install and update remedy', () => {
  const home = tmp('sterling-agy-home-');
  const env = {};
  assert.deepEqual(scanInstalledSterling(env, home).copies, [], 'no agy dir is no copy and no skip');
  copyAt(agyCopy(home), '1.2.0');
  assert.deepEqual(newestInstalledSterling(env, home), { root: agyCopy(home), version: '1.2.0', host: 'agy' });
  assert.equal(installHostOf(agyCopy(home), { env, home }), 'agy');
  copyAt(opencodeCopy(home, '1.2.0'), '1.2.0');
  assert.equal(newestInstalledSterling(env, home).host, 'opencode', 'opencode wins a tie over agy');
  copyAt(claudeCopy(home, '1.2.0'), '1.2.0');
  assert.equal(newestInstalledSterling(env, home).host, 'claude-code', 'claude-code wins a tie over both');
  copyAt(agyCopy(home), '1.3.0');
  assert.equal(newestInstalledSterling(env, home).host, 'agy', 'a newer agy copy wins');
  assert.match(sterlingInstallRemedy('agy'), /^agy plugin install /);
  assert.match(sterlingUpdateRemedy('agy', { env, home }), /agy plugin install .*no plugin update command/);
  assert.match(sterlingUpdateRemedy(null, { env, home }), /\(Antigravity CLI\)/);
});

test('agyMcpRoot: a clone bakes itself; an installed copy names agy\'s copy when it has the server, else itself', () => {
  const home = tmp('sterling-agy-root-');
  const running = copyAt(claudeCopy(home, '2.0.0'), '2.0.0');
  assert.equal(agyMcpRoot({ pluginRoot: repo, home, installed: false }).root, repo);
  assert.equal(agyMcpRoot({ pluginRoot: running, env: {}, home }).root, running);
  copyAt(agyCopy(home), '2.0.0');
  assert.deepEqual(agyMcpRoot({ pluginRoot: running, env: {}, home }), { root: agyCopy(home), why: "agy's installed Sterling" });
});

// ---------- three-host post-update sync (decision dual-host-post-update-sync-newest-copy-wins) ----------

const SYNC_OK = (out = '') => async (root, name) => ({ status: 0, out: name === 'sync-agents.mjs' ? out : 'stamp-contract — 1 project(s) processed, 1 already in sync, 0 refusal(s).', tail: '' });

test('three hosts: switching host order never downgrades the marker and never ping-pongs', async () => {
  const home = tmp('sterling-agy-3h-');
  const project = tmp('sterling-agy-3h-proj-');
  mkdirSync(join(project, '.sterling'));
  writeFileSync(join(project, '.sterling', 'config.json'), '{}');
  const marker = () => readFileSync(join(project, '.sterling', 'synced-version'), 'utf8').trim();
  const copies = { claude: copyAt(claudeCopy(home, '0.1.0'), '0.1.0'), opencode: copyAt(opencodeCopy(home, '0.3.0'), '0.3.0'), agy: copyAt(agyCopy(home), '0.2.0') };
  const run = (host) => postUpdateSync({ root: copies[host], project, host, runStep: SYNC_OK(), env: {}, home });

  assert.equal((await run('agy')).outcome, 'synced');
  assert.equal(marker(), '0.2.0');
  const older = await run('claude');
  assert.equal(older.outcome, 'refused-older');
  assert.match(older.warning, /update it through \/plugin/);
  assert.equal(marker(), '0.2.0', 'an older Claude copy never downgrades');
  assert.equal((await run('opencode')).outcome, 'synced');
  assert.equal(marker(), '0.3.0');
  const agyOlder = await run('agy');
  assert.equal(agyOlder.outcome, 'refused-older');
  assert.match(agyOlder.warning, /agy plugin install/);
  assert.match(agyOlder.context, /POST-UPDATE SYNC REFUSED \(agy session start\)/);
  assert.equal(marker(), '0.3.0');
  // Alternate the hosts again: the newest copy already synced, so nobody re-syncs.
  assert.equal(await run('opencode'), null);
  assert.equal((await run('claude')).outcome, 'refused-older');
  assert.equal(marker(), '0.3.0');
});

test('agy host: a skipped agy setup in sync-agents is a failed step, and written agy agents owe a restart', async () => {
  const skip = await runPostUpdateSteps('/r', '/p', SYNC_OK('Antigravity CLI (agy): agy not installed (x) — Sterling on Antigravity CLI SKIPPED: ...'), 'agy');
  assert.equal(skip.ok, false);
  assert.match(skip.detail, /did not refresh the agy agents/);
  const sameLineOnClaude = await runPostUpdateSteps('/r', '/p', SYNC_OK('Antigravity CLI (agy): agy not installed (x) — SKIPPED'), 'claude');
  assert.notEqual(sameLineOnClaude.detail ?? '', skip.detail, 'only a running agy treats the skip as a failure');
  const written = await runPostUpdateSteps('/r', '/p', SYNC_OK('Antigravity CLI (agy) refreshed: .agents/agents/scout/agent.md'), 'agy');
  assert.equal(written.restart, true);
});

// ---------- stamp-contract keeps AGENTS.md, CLAUDE.md and GEMINI.md in step ----------

test('stamp-contract --apply-inserts: a CLAUDE.md bullet missing from GEMINI.md is inserted there in its agy wording; CLAUDE.md is untouched', () => {
  const scratchDir = tmp('sterling-agy-stamp-');
  const proj = tmp('sterling-agy-stamp-proj-');
  const regDb = join(scratchDir, 'registry.db');
  const fill = (s) => s.replaceAll('{{PROJECT_NAME}}', 'p').replaceAll('{{STACK_TAGS}}', 'node').replaceAll('{{TOOLCHAINS}}', 'node').replaceAll('{{LINT_COMMAND}}', 'x').replaceAll('{{DOMAINS}}', 'x').replaceAll('{{BACKUP_PATH}}', 'x').replaceAll('{{CONVENTIONS_SECTION}}', 'x');
  return import('../lib/agent-fences.mjs').then(({ renderClaudeText }) => {
    const claude = fill(renderClaudeText(readFileSync(join(repo, 'templates/target-claude-md.md'), 'utf8'), 'c'));
    writeFileSync(join(proj, 'AGENTS.md'), fill(renderClaudeText(readFileSync(join(repo, 'templates/target-agents-md.md'), 'utf8'), 'a')));
    writeFileSync(join(proj, 'CLAUDE.md'), claude);
    const gemini = renderGeminiMd({ pluginRoot: repo, root: repo, projectName: 'p' });
    const lead = '- **Concept articles — capture design the moment it settles';
    const b = extractBlock(gemini, lead);
    assert.ok(b && /agy has no Stop block/.test(b.block), 'the agy wording of the bullet differs from the Claude one');
    const lines = gemini.split('\n');
    lines.splice(b.start, b.end - b.start);
    writeFileSync(join(proj, 'GEMINI.md'), lines.join('\n'));
    const registry = new ProjectRegistry(regDb);
    registry.register({ repo_path: proj, name: 'agy-stamp', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    registry.close();
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'stamp-contract.mjs'), '--apply-inserts', '--project', proj], { cwd: repo, encoding: 'utf8', env: { ...process.env, STERLING_REGISTRY_DB: regDb } });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /inserted {2}\[GEMINI\.md\] - \*\*Concept articles/);
    const after = readFileSync(join(proj, 'GEMINI.md'), 'utf8');
    assert.equal(extractBlock(after, lead)?.block, b.block, 'GEMINI.md regains the exact agy bullet, with the Sterling root filled in');
    assert.equal(after.split(lead).length, 2, 'one copy');
    assert.equal(after.length, gemini.length, 'nothing else changed');
    assert.equal(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), claude, 'CLAUDE.md untouched');
    assert.match(out, /AGENTS\.md \+ .*CLAUDE\.md \+ .*GEMINI\.md/);
    // In step: a second run has nothing to do.
    const again = spawnSync(process.execPath, [join(repo, 'scripts', 'stamp-contract.mjs'), '--apply-inserts', '--project', proj], { cwd: repo, encoding: 'utf8', env: { ...process.env, STERLING_REGISTRY_DB: regDb } });
    assert.equal(again.status, 0, again.stdout);
    assert.match(again.stdout, /1 already in sync/);
  });
});

// ---------- init and sync-agents ----------

function spawnEnv(extra) {
  const env = { ...process.env, STERLING_CLAUDE_PROBE: 'absent', STERLING_OPENCODE_SETUP_DISABLE: '1', ...extra };
  delete env.STERLING_AGY_SETUP_DISABLE;
  return env;
}

test('sync-agents: agy absent prints one skip line and writes nothing for agy; agy present writes the roster and GEMINI.md', () => {
  const dir = gitProject();
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const sync = (probe) => spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', timeout: 60_000, env: spawnEnv({ STERLING_AGY_PROBE: probe }) });
  const absent = sync('absent');
  assert.equal(absent.status, 0, absent.stdout + absent.stderr);
  assert.equal(absent.stdout.split('\n').filter((l) => l.startsWith('Antigravity CLI (agy)')).length, 1, absent.stdout);
  assert.match(absent.stdout, /^Antigravity CLI \(agy\): agy not installed \(STERLING_AGY_PROBE=absent\)/m);
  assert.equal(existsSync(join(dir, '.agents')), false);
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
  const present = sync('ok');
  assert.equal(present.status, 0, present.stdout + present.stderr);
  assert.match(present.stdout, /^Antigravity CLI \(agy\) created: \.agents\/agents\/conductor\/agent\.md$/m);
  assert.ok(existsSync(join(dir, 'GEMINI.md')));
  assert.doesNotMatch(present.stdout, /^[a-z_]+: .*agy/m, 'no line /sterling:update would count as an agent change');
});

test('init: agy absent leaves the project as before (no .agents/, no GEMINI.md, one skipped row); agy present adds them', () => {
  const run = (probe) => {
    const dir = gitProject();
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'init.mjs'), '--target', dir, '--project-name', 'agyinit', '--stack-tags', 'node', '--domain-description', 'node=test domain node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--mode', 'hobby'], {
      encoding: 'utf8',
      cwd: dir,
      timeout: 180_000,
      env: spawnEnv({ HOME: tmp('sterling-agy-init-home-'), STERLING_REGISTRY_DB: join(dir, 'registry.db'), STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-agy-init-root-'), CLAUDE_CONFIG_DIR: tmp('sterling-agy-init-cfg-'), STERLING_CODEX_PROBE: 'absent', STERLING_LAUNCHER_OPENCODE: 'absent', STERLING_AGY_PROBE: probe }),
    });
    return { dir, code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const absent = run('absent');
  assert.equal(absent.code, 0, absent.out);
  assert.equal(existsSync(join(absent.dir, '.agents')), false);
  assert.equal(existsSync(join(absent.dir, 'GEMINI.md')), false);
  assert.equal((absent.out.match(/agy not installed \(STERLING_AGY_PROBE=absent\)/g) ?? []).length, 1, absent.out);
  const present = run('ok');
  assert.equal(present.code, 0, present.out);
  assert.ok(existsSync(join(present.dir, '.agents', 'agents', 'conductor', 'agent.md')), present.out);
  assert.match(readFileSync(join(present.dir, 'GEMINI.md'), 'utf8'), /— agyinit \(Sterling layer\)/);
});
