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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { ProjectRegistry } from '@sterling/store';
import {
  AGY_MCP_READ_ONLY_SERVER_NAME,
  AGY_MCP_SERVER_NAME,
  AGY_READ_ONLY_ROLES,
  AGY_ROSTER,
  AGY_TOOLS,
  GEMINI_MD_MAX_BYTES,
  agyMcpRoot,
  agyModelsOf,
  readAgyModels,
  ensureAgyExcluded,
  ensureGeminiMd,
  geminiRootAlias,
  geminiRootFor,
  formatAgyRows,
  probeMcpServer,
  probeAgy,
  renderAgyAgent,
  renderGeminiMd,
  setupAgy,
  trackedFiles,
} from '../lib/agy-setup.mjs';
import { ROSTER } from '../lib/opencode-install.mjs';
import { installHostOf, newestInstalledSterling, scanInstalledSterling, sterlingInstallRemedy, sterlingUpdateRemedy } from '../lib/sterling-roots.mjs';
import { postUpdateSync, runPostUpdateSteps, runStepSync } from '../lib/post-update-sync.mjs';
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

test('agent.md per role: agy frontmatter, `sterling` for writing roles and `sterling-ro` with --read-only for read-only roles, on execPath with --project ., and the stamp as the first body line', () => {
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
    const base = [`${repo}/mcp/sterling-mcp.mjs`, '--project', '.'];
    const expected = AGY_READ_ONLY_ROLES.has(name)
      ? { name: 'sterling-ro', command: NODE, args: [...base, '--read-only'] }
      : { name: 'sterling', command: NODE, args: base };
    assert.deepEqual(fm.mcpServers, [expected], `${name}: its MCP entry`);
    assert.match(body.split('\n')[0], /^<!-- sterling-agy renderer=agy\/1 template=/);
    assert.doesNotMatch(body, /\{\{[A-Z_]+\}\}/);
    assert.doesNotMatch(body, /<!-- \/?(claude|opencode|agy|sterling|portable)-only -->/);
    if (READ_ONLY.includes(name)) for (const t of WRITE_TOOLS) assert.ok(!fm.tools.includes(t), `${name} must not get ${t}`);
    if (name !== 'conductor') assert.ok(!fm.tools.includes('invoke_subagent'), `${name} cannot dispatch`);
  }
  // The read-only set is exactly the ruled one, and the two entry names differ (agy deduplicates servers by entry name).
  assert.deepEqual([...AGY_READ_ONLY_ROLES].sort(), ['preflight', 'researcher', 'reviewer', 'scout', 'sparring']);
  assert.ok([...AGY_READ_ONLY_ROLES].every((n) => AGY_ROSTER.includes(n)), 'every read-only role is in the roster');
  assert.notEqual(AGY_MCP_READ_ONLY_SERVER_NAME, AGY_MCP_SERVER_NAME);
  const names = new Set(AGY_ROSTER.map((n) => frontmatter(readFileSync(join(dir, '.agents', 'agents', n, 'agent.md'), 'utf8')).fm.mcpServers[0].name));
  assert.deepEqual([...names].sort(), ['sterling', 'sterling-ro']);
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
  // The FILLED render: {{STERLING_ROOT}} is replaced by an absolute path several times, so
  // the size depends on the root. This checkout's real path must fit.
  const text = renderGeminiMd({ pluginRoot: repo, root: repo, projectName: 'demo' });
  assert.ok(Buffer.byteLength(text) <= GEMINI_MD_MAX_BYTES, `${Buffer.byteLength(text)} bytes with the root ${repo}`);
  assert.ok(text.includes(`node "${repo}/bin/rotation-note.mjs"`), 'the real root is filled in');
  // A root of about 200 characters does not fit (measured 2026-11-18: 24,121 bytes), so the render refuses with the byte count.
  const longRoot = `/home/${'u'.repeat(194)}`;
  assert.equal(longRoot.length, 200);
  assert.throws(() => renderGeminiMd({ pluginRoot: repo, root: longRoot, projectName: 'demo' }), /is \d+ bytes, over agy's 24000-byte cap/);
  assert.doesNotMatch(text, /^@AGENTS\.md/m);
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  assert.match(text, /# CLAUDE\.md — demo \(Sterling layer\)/);
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

test('GEMINI.md: a Sterling root over 180 characters goes through a short per-user link, and a blocked link refuses loudly', () => {
  const home = tmp('sterling-agy-home-');
  const longRoot = join(tmp('sterling-agy-long-'), 'a'.repeat(100), 'b'.repeat(100));
  copyAt(longRoot, '1.0.0');
  const dir = gitProject();
  const run = () => ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: longRoot, home });
  assert.ok(longRoot.length > 200);
  const alias = geminiRootAlias(home);
  assert.equal(run().status, 'created');
  const text = readFileSync(join(dir, 'GEMINI.md'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= GEMINI_MD_MAX_BYTES);
  assert.ok(text.includes(`node "${alias}/bin/rotation-note.mjs"`), 'the short link stands in for the root');
  assert.ok(!text.includes(longRoot));
  assert.equal(readFileSync(join(alias, 'mcp', 'sterling-mcp.mjs'), 'utf8'), '', 'the link reaches the real root');
  assert.equal(run().status, 'matches');
  const moved = join(tmp('sterling-agy-long2-'), 'c'.repeat(200));
  copyAt(moved, '2.0.0');
  assert.equal(ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: moved, home }).status, 'matches');
  assert.ok(existsSync(join(alias, '.claude-plugin', 'plugin.json')) && JSON.parse(readFileSync(join(alias, 'package.json'), 'utf8')).version === '2.0.0', 'the link follows the new root');
  const blocked = tmp('sterling-agy-blocked-');
  mkdirSync(join(blocked, '.gemini', 'sterling-root'), { recursive: true });
  const row = ensureGeminiMd({ projectDir: gitProject(), pluginRoot: repo, root: longRoot, home: blocked });
  assert.equal(row.status, 'refused');
  assert.match(row.detail, /is not a link Sterling made/);
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
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'init.mjs'), '--target', dir, '--project-name', 'agyinit', '--stack-tags', 'node', '--domain-description', 'node=test domain node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'], { // --mode is retired (settings redesign item C)
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

// ---------- a failing git inventory (review fix round) ----------

test('a failing git ls-files inside a checkout refuses every agy write and names git\'s error; outside a checkout nothing is tracked', () => {
  const dir = gitProject();
  // A Sterling-stamped conductor that an unknown inventory would otherwise refresh, tracked by git.
  const rel = '.agents/agents/conductor/agent.md';
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  const older = renderAgyAgent(readFileSync(join(repo, 'agent-templates', 'conductor.md'), 'utf8'), 'c', 'conductor', { root: repo, nodePath: '/old/node' });
  writeFileSync(join(dir, rel), older);
  git(dir, 'add', '-f', rel);
  writeFileSync(join(dir, '.git', 'index'), 'not an index');
  const ls = git(dir, 'ls-files');
  assert.equal(ls.status, 128, 'the broken index makes git ls-files fail with exit 128');
  const excludeBefore = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  const r = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  const refused = r.rows.filter((x) => x.refused);
  assert.equal(refused.length, 1, JSON.stringify(r.rows));
  assert.match(refused[0].detail, /git ls-files failed .*exit 128: .*index/);
  assert.match(refused[0].instruction, /^REFUSED: /);
  assert.equal(readFileSync(join(dir, rel), 'utf8'), older, 'the tracked agent is not refreshed');
  assert.equal(existsSync(join(dir, '.agents', 'agents', 'scout')), false, 'no other agent written');
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);

  const plain = tmp('sterling-agy-nogit-');
  const failing = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  assert.deepEqual(trackedFiles(plain, ['GEMINI.md'], failing), { tracked: [] });
  assert.deepEqual(trackedFiles(dir, ['GEMINI.md'], failing), { failed: 'exit 128: fatal: not a git repository' });
});

// ---------- a project set up only for agy (no CLAUDE.md) ----------

function agyOnlyProject() {
  const proj = tmp('sterling-agy-only-');
  git(proj, 'init', '-q');
  const fill = (t) => t.replaceAll('{{PROJECT_NAME}}', 'p').replaceAll('{{STACK_TAGS}}', 'node').replaceAll('{{TOOLCHAINS}}', 'node').replaceAll('{{LINT_COMMAND}}', 'x').replaceAll('{{DOMAINS}}', 'x').replaceAll('{{BACKUP_PATH}}', 'x').replaceAll('{{CONVENTIONS_SECTION}}', 'x');
  return import('../lib/agent-fences.mjs').then(({ renderClaudeText }) => {
    writeFileSync(join(proj, 'AGENTS.md'), fill(renderClaudeText(readFileSync(join(repo, 'templates/target-agents-md.md'), 'utf8'), 'a')));
    const gemini = renderGeminiMd({ pluginRoot: repo, root: repo, projectName: 'p' });
    const lead = '- **Concept articles — capture design the moment it settles';
    const b = extractBlock(gemini, lead);
    const lines = gemini.split('\n');
    lines.splice(b.start, b.end - b.start);
    writeFileSync(join(proj, 'GEMINI.md'), lines.join('\n'));
    const regDb = join(tmp('sterling-agy-only-reg-'), 'registry.db');
    const registry = new ProjectRegistry(regDb);
    registry.register({ repo_path: proj, name: 'agy-only', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    registry.close();
    return { proj, regDb, lead, block: b.block };
  });
}

test('stamp-contract: a project with AGENTS.md and GEMINI.md but no CLAUDE.md is processed, and GEMINI.md gains the missing bullet', async () => {
  const { proj, regDb, lead, block } = await agyOnlyProject();
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'stamp-contract.mjs'), '--apply-inserts', '--project', proj], { cwd: repo, encoding: 'utf8', env: { ...process.env, STERLING_REGISTRY_DB: regDb } });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /— 1 project\(s\) processed/);
  assert.doesNotMatch(out, /no_claude_md/);
  assert.match(out, /inserted {2}\[GEMINI\.md\] - \*\*Concept articles/);
  assert.equal(extractBlock(readFileSync(join(proj, 'GEMINI.md'), 'utf8'), lead)?.block, block);
  assert.equal(existsSync(join(proj, 'CLAUDE.md')), false, 'no CLAUDE.md is created');
  // Neither host layer: still refused, as before agy.
  rmSync(join(proj, 'GEMINI.md'));
  const none = spawnSync(process.execPath, [join(repo, 'scripts', 'stamp-contract.mjs'), '--apply-inserts', '--project', proj], { cwd: repo, encoding: 'utf8', env: { ...process.env, STERLING_REGISTRY_DB: regDb } });
  assert.equal(none.status, 2);
  assert.match(none.stdout, /✗ agy-only: no_claude_md/);
});

test('post-update sync on agy: an agy-only project runs sync-agents and stamp-contract through to a synced result', async () => {
  const { proj, regDb } = await agyOnlyProject();
  mkdirSync(join(proj, '.sterling'));
  writeFileSync(join(proj, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const keys = ['STERLING_REGISTRY_DB', 'STERLING_CLAUDE_PROBE', 'STERLING_AGY_PROBE', 'STERLING_AGY_SETUP_DISABLE', 'STERLING_OPENCODE_SETUP_DISABLE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { STERLING_REGISTRY_DB: regDb, STERLING_CLAUDE_PROBE: 'absent', STERLING_AGY_PROBE: 'ok', STERLING_OPENCODE_SETUP_DISABLE: '1' });
  delete process.env.STERLING_AGY_SETUP_DISABLE;
  try {
    const result = await runPostUpdateSteps(repo, proj, runStepSync, 'agy');
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.restart, true, 'sync-agents wrote the agy agents');
    assert.ok(result.inserted.some((i) => /\[GEMINI\.md\] - \*\*Concept articles/.test(i)), JSON.stringify(result));
    assert.ok(existsSync(join(proj, '.agents', 'agents', 'conductor', 'agent.md')));
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---------- review fixes: mixed versions, the GEMINI.md root link ----------

// A server from before read-only mode, as its entry point behaves: --capabilities is not a flag it
// knows, so it fails the --project/--store usage check with exit 2 (packages/mcp-server/src/main.ts
// before 96054356). A server with read-only mode prints its capability line.
const OLD_SERVER = "const a = process.argv.slice(2);\nif (!a.includes('--project') && !a.includes('--store')) { console.error('usage: sterling-mcp --project <project root>'); process.exit(2); }\n";
const NEW_SERVER = "if (process.argv.includes('--capabilities')) { console.log(JSON.stringify({ sterling_mcp: { read_only: true } })); process.exit(0); }\nprocess.exit(2);\n";

test('mixed versions: agy\'s older installed copy cannot enforce --read-only, so no agent file is written and the remedy names agy plugin install; a current copy gets them', () => {
  const home = tmp('sterling-agy-mixed-');
  const copy = copyAt(agyCopy(home), '0.19.150');
  writeFileSync(join(copy, 'mcp', 'sterling-mcp.mjs'), OLD_SERVER);
  const dir = gitProject();
  const old = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, home, installed: true, nodePath: NODE });
  assert.equal(old.root, copy, "agy's copy is the selected root");
  const refused = old.rows.find((r) => r.item === '.agents/agents/');
  assert.equal(refused?.status, 'refused', JSON.stringify(old.rows));
  assert.match(refused.detail, /cannot enforce --read-only .*exited 2, so that server predates read-only mode/);
  assert.match(refused.instruction, new RegExp(`agy plugin install ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(join(dir, '.agents')), false, 'no agent file, so no sterling-ro entry points at a server that ignores --read-only');
  assert.equal(old.rows.find((r) => r.item === 'GEMINI.md')?.status, 'created', 'GEMINI.md does not depend on the server');

  writeFileSync(join(copy, 'mcp', 'sterling-mcp.mjs'), NEW_SERVER);
  const current = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, home, installed: true, nodePath: NODE });
  assert.equal(current.rows.filter((r) => r.status === 'refused').length, 0, JSON.stringify(current.rows));
  const reviewer = frontmatter(readFileSync(join(dir, '.agents', 'agents', 'reviewer', 'agent.md'), 'utf8')).fm;
  assert.deepEqual(reviewer.mcpServers, [{ name: 'sterling-ro', command: NODE, args: [`${copy}/mcp/sterling-mcp.mjs`, '--project', '.', '--read-only'] }]);
});

test('probeMcpServer: this checkout\'s server reports read-only mode; an old, a silent and a missing server do not', () => {
  assert.deepEqual(probeMcpServer({ root: repo }), { readOnly: true });
  const root = tmp('sterling-agy-probe-');
  mkdirSync(join(root, 'mcp'));
  const server = join(root, 'mcp', 'sterling-mcp.mjs');
  writeFileSync(server, OLD_SERVER);
  assert.match(probeMcpServer({ root }).reason, /exited 2/);
  writeFileSync(server, '');
  assert.match(probeMcpServer({ root }).reason, /does not report read_only/);
  rmSync(server);
  assert.equal(probeMcpServer({ root }).readOnly, false);
});

test('stamp-contract: a fresh GEMINI.md written through the short root link is in sync, not HAND_TUNED', async () => {
  const { proj, regDb } = await agyOnlyProject();
  const home = tmp('sterling-agy-stamp-home-');
  const alias = geminiRootAlias(home);
  writeFileSync(join(proj, 'GEMINI.md'), renderGeminiMd({ pluginRoot: repo, root: alias, projectName: 'p' }));
  assert.equal(geminiRootFor(readFileSync(join(proj, 'GEMINI.md'), 'utf8'), { root: repo, home }), alias);
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'stamp-contract.mjs'), '--project', proj], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, STERLING_REGISTRY_DB: regDb } });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /HAND_TUNED/);
  assert.match(out, /1 already in sync/);
});

test('GEMINI.md root link upkeep: an edited doc, a changed template and a long-to-short root move all repoint the link; the doc is never rewritten; a non-link is refused', () => {
  const home = tmp('sterling-agy-upkeep-');
  const alias = geminiRootAlias(home);
  const longRoot = copyAt(join(tmp('sterling-agy-up-long-'), 'a'.repeat(100), 'b'.repeat(100)), '1.0.0');
  const versionAtLink = () => JSON.parse(readFileSync(join(alias, 'package.json'), 'utf8')).version;
  const dir = gitProject();
  assert.equal(ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: longRoot, home }).status, 'created');
  const path = join(dir, 'GEMINI.md');
  const edited = `${readFileSync(path, 'utf8')}\nmy own line\n`;
  writeFileSync(path, edited);

  const moved = copyAt(join(tmp('sterling-agy-up-moved-'), 'c'.repeat(200)), '2.0.0');
  assert.equal(ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: moved, home }).status, 'differs');
  assert.equal(versionAtLink(), '2.0.0', 'an edited doc still gets its link repointed');

  const templateRoot = tmp('sterling-agy-up-tpl-');
  mkdirSync(join(templateRoot, 'templates'));
  writeFileSync(join(templateRoot, 'templates', 'target-claude-md.md'), `${readFileSync(join(repo, 'templates', 'target-claude-md.md'), 'utf8')}\nA new template line.\n`);
  const third = copyAt(join(tmp('sterling-agy-up-third-'), 'd'.repeat(200)), '3.0.0');
  assert.equal(ensureGeminiMd({ projectDir: dir, pluginRoot: templateRoot, root: third, home }).status, 'differs');
  assert.equal(versionAtLink(), '3.0.0', 'a changed template still repoints the link');

  const short = copyAt(tmp('sterling-agy-up-s-'), '4.0.0');
  assert.equal(ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: short, home }).status, 'differs');
  assert.equal(versionAtLink(), '4.0.0', 'a move to a short root keeps the link the doc names');
  assert.equal(readFileSync(path, 'utf8'), edited, 'GEMINI.md is never rewritten');

  // An untouched aliased doc stays 'matches' after a long-to-short move: setup compares it in the link form.
  const fresh = gitProject();
  assert.equal(ensureGeminiMd({ projectDir: fresh, pluginRoot: repo, root: longRoot, home }).status, 'created');
  assert.equal(ensureGeminiMd({ projectDir: fresh, pluginRoot: repo, root: short, home }).status, 'matches');

  rmSync(alias);
  mkdirSync(alias);
  const row = ensureGeminiMd({ projectDir: dir, pluginRoot: repo, root: short, home });
  assert.equal(row.status, 'refused');
  assert.match(row.detail, /is not a link Sterling made/);
  assert.equal(readFileSync(path, 'utf8'), edited);
});

test('probeMcpServer: a server that ignores SIGTERM and never answers is killed at the timeout and reported as not read-only', () => {
  const root = tmp('sterling-agy-probe-hang-');
  mkdirSync(join(root, 'mcp'));
  // Never answers and ignores SIGTERM; it ends itself after 60 s so a failed run leaves nothing behind for long.
  writeFileSync(join(root, 'mcp', 'sterling-mcp.mjs'), "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 60_000);\n");
  // The probe blocks its process, so it runs in a child the test can bound.
  const script = `import(${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'lib', 'agy-setup.mjs')).href)}).then(({ probeMcpServer }) => { const t = Date.now(); const r = probeMcpServer({ root: ${JSON.stringify(root)}, timeoutMs: 1000 }); console.log(JSON.stringify({ ...r, ms: Date.now() - t })); });`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, `the probe did not return within 15 s (signal ${run.signal}): ${run.stderr}`);
  const r = JSON.parse(run.stdout);
  assert.equal(r.readOnly, false);
  assert.match(r.reason, /--capabilities did not answer within 1000 ms and was killed/);
  assert.ok(r.ms < 5000, `returned after ${r.ms} ms`);
});

// ---------- agy_model (issue #306) ----------

test('renderAgyAgent writes the pinned agy model, and model: inherit when none is set', () => {
  const tpl = readFileSync(join(repo, 'agent-templates', 'implementor.md'), 'utf8');
  const pinned = renderAgyAgent(tpl, 't', 'implementor', { root: repo, nodePath: NODE, agyModel: 'pro' });
  assert.match(pinned, /^model: pro$/m);
  assert.doesNotMatch(pinned, /^model: inherit$/m);
  const unset = renderAgyAgent(tpl, 't', 'implementor', { root: repo, nodePath: NODE });
  assert.match(unset, /^model: inherit$/m);
});

test('agyModelsOf reads config.models.<role>.agy_model and ignores roles without one; a value outside agy\'s four is ignored, never thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-models-'));
  try {
    assert.deepEqual(agyModelsOf(dir), {}, 'no config: nothing pinned');
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ models: { implementor: { model: 'm', effort: 'high', agy_model: 'flash' }, scout: { model: 'm', effort: 'low' } } }));
    assert.deepEqual(agyModelsOf(dir), { implementor: 'flash' });
    // Changed 2026-11-18 (GitHub #310): this used to throw on a malformed id. A v0.19.155 config may hold an exact id,
    // and loading must not fail, so the value is reported in `ignored` and the role renders inherit.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ models: { scout: { agy_model: 'claude-opus-5-5-high' }, implementor: { agy_model: 'pro' } } }));
    assert.deepEqual(readAgyModels(dir), { pins: { implementor: 'pro' }, ignored: [{ role: 'scout', value: 'claude-opus-5-5-high' }] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each of agy\'s four model values renders verbatim, and an unlisted value renders inherit', () => {
  const tpl = readFileSync(join(repo, 'agent-templates', 'implementor.md'), 'utf8');
  for (const v of ['inherit', 'flash_lite', 'flash', 'pro']) {
    assert.match(renderAgyAgent(tpl, 't', 'implementor', { root: repo, nodePath: NODE, agyModel: v }), new RegExp(`^model: ${v}$`, 'm'));
  }
  assert.match(renderAgyAgent(tpl, 't', 'implementor', { root: repo, nodePath: NODE, agyModel: 'claude-opus-5-5-high' }), /^model: inherit$/m);
});

test('setupAgy with a stale exact agy_model in config writes model: inherit and names the role and the ignored value', () => {
  const dir = gitProject();
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ models: { sparring: { model: 'claude-opus-5-5', effort: 'high', agy_model: 'claude-opus-5-5-high' } } }));
  const r = setupAgy({ projectDir: dir, pluginRoot: repo, env: ON, installed: false, nodePath: NODE });
  const row = r.rows.find((x) => x.item === 'models.sparring.agy_model');
  assert.ok(row, JSON.stringify(r.rows));
  assert.equal(row.status, 'ignored');
  assert.match(row.detail, /"claude-opus-5-5-high" is not one of inherit, flash_lite, flash, pro/);
  assert.match(readFileSync(join(dir, '.agents', 'agents', 'sparring', 'agent.md'), 'utf8'), /^model: inherit$/m);
});

// Changed 2026-11-18 (GitHub #310, user ruling "Accept agy's 4 values"): #309 pinned the shipped sparring agy agent to
// claude-opus-5-5-high, but agy 1.5.11 drops a subagent with a model outside its four values, so the shipped
// default pins nothing and every agy agent renders model: inherit.
test('the shipped default config pins no agy model: every agy agent renders model: inherit (issue #310)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-default-pin-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), readFileSync(join(repo, 'templates', 'default-config.json'), 'utf8'));
    assert.deepEqual(agyModelsOf(dir), {});
    for (const name of AGY_ROSTER) {
      const text = renderAgyAgent(readFileSync(join(repo, 'agent-templates', `${name}.md`), 'utf8'), 't', name, { root: repo, nodePath: NODE });
      assert.match(text, /^model: inherit$/m, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
