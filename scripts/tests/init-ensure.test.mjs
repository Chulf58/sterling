// §12 ensure-manifest semantics: per-item verify → create absent → skip
// matching → leave-and-report hand-edited; refusal only for destructive
// actions; every manifest artifact individually regenerable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function init(dir, args = []) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    // isolate the machine-global project registry to this test's temp dir, so
    // init's registration never pollutes the real ~/.sterling/registry.db
    env: { ...process.env, STERLING_REGISTRY_DB: join(dir, 'registry.db') },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const FRESH_FLAGS = ['--project-name', 'ensure-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];
// .mcp.json is NOT a per-project artifact: the plugin declares the sterling
// server (bound per-project via ${CLAUDE_PROJECT_DIR}), so a consuming project
// never gets one. Its absence is asserted directly below.
const ARTIFACTS = ['.sterling/config.json', 'CLAUDE.md', 'sterling.bat', 'tui.bat', '.gitignore'];
const snapshot = (dir) => Object.fromEntries(ARTIFACTS.map((a) => [a, readFileSync(join(dir, a), 'utf8')]));

test('ensure outcome 1 — create absent: fresh init creates every manifest item and records declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    for (const a of [...ARTIFACTS, '.sterling/sterling.db', '.sterling/runs', 'docs/briefs', '.claude/agents/coder.md']) {
      assert.ok(existsSync(join(dir, a)), `created ${a}`);
    }
    // a consuming project gets NO per-project .mcp.json — the plugin declares sterling
    assert.ok(!existsSync(join(dir, '.mcp.json')), 'no per-project .mcp.json — the plugin declares the sterling server');
    assert.match(r.stdout, /^\.mcp\.json\s+matches\s+not written — the plugin declares sterling/m);
    // init never manages .claude/settings.local.json (decision 097851ed, refined): the MCP
    // dual-role is gone (the plugin declares its server via plugin.json mcpServers, not a root
    // .mcp.json), so no enable-flag enforcement is needed — a consuming project keeps its own.
    assert.ok(!existsSync(join(dir, '.claude', 'settings.local.json')), 'consuming project: settings.local.json left to the user (init never writes it)');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m);
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m);
    assert.match(r.stdout, /RESTART REQUIRED/, 'agents installed → restart instruction');
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(config.project_name, 'ensure-target', 'project name recorded for flagless re-runs');
    assert.ok(config.backup_path.endsWith('/backups'), 'backup path recorded absolute, forward slashes');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('ensure outcome 2 — skip matching: a flagless re-run reports matches and changes no byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const before = snapshot(dir);
    const rerun = init(dir); // NO flags: declarations read back from the recorded config
    assert.equal(rerun.code, 0, rerun.stderr);
    for (const item of ['\\.sterling/config\\.json', 'CLAUDE\\.md', 'sterling\\.bat', '\\.mcp\\.json', '\\.gitignore']) {
      assert.match(rerun.stdout, new RegExp(`^${item}\\s+matches\\b`, 'm'), `${item} reported as matching`);
    }
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+matches\b/m);
    assert.match(rerun.stdout, /^\.sterling\/sterling\.db\s+exists\b/m, 'store is data — exists, never compared or recreated');
    assert.match(rerun.stdout, /no agent changes — no restart required/);
    assert.ok(!/RESTART REQUIRED/.test(rerun.stdout), 'no restart demanded when nothing changed');
    assert.deepEqual(snapshot(dir), before, 'matching re-run is byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('ensure outcome 3 — leave-and-report: hand-edited config, CLAUDE.md, and agent are left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    // tune the config, edit the contract, modify an installed agent body
    const configPath = join(dir, '.sterling', 'config.json');
    const tuned = JSON.parse(readFileSync(configPath, 'utf8'));
    tuned.caps.inner_loop_n = 7;
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));
    appendFileSync(join(dir, 'CLAUDE.md'), '\n## Local additions\n- the human wrote this\n');
    appendFileSync(join(dir, '.claude', 'agents', 'coder.md'), '\nlocal tweak\n');
    const before = snapshot(dir);
    const agentBefore = readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+differs\s+left untouched/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the conductor contract by hand/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+differs\s+locally modified/m);
    assert.deepEqual(snapshot(dir), before, 'hand-edited files untouched');
    assert.equal(readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8'), agentBefore, 'modified agent untouched');
    // tuned declarations still drive the run: caps came from the recorded config
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).caps.inner_loop_n, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('never-clobber: a pre-existing CLAUDE.md survives the FIRST init byte-for-byte; init completes around it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const ownContract = '# My project\n\nHand-written build contract. Sacred.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), ownContract);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `init completes around the existing CLAUDE.md, no refusal: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), ownContract, 'NEVER clobbered');
    assert.match(r.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the conductor contract by hand/m);
    for (const a of ['.sterling/config.json', '.sterling/sterling.db', 'sterling.bat', '.claude/agents/coder.md']) {
      assert.ok(existsSync(join(dir, a)), `the rest of the manifest still created: ${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('refusal only for destructive actions: a FILE where .sterling/ must be a directory refuses before any write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    writeFileSync(join(dir, '.sterling'), 'not a directory');
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /REFUSED \(destructive\)/);
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'refusal happened before any write');
    assert.ok(!existsSync(join(dir, '.sterling', 'config.json')), 'refusal happened before any write');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('individually regenerable: deleted artifacts are recreated by a flagless re-run; the rest still match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const launcherBefore = readFileSync(join(dir, 'sterling.bat'), 'utf8');
    unlinkSync(join(dir, 'sterling.bat'));
    unlinkSync(join(dir, '.claude', 'agents', 'coder.md'));

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^sterling\.bat\s+created\b/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+created\b/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+matches\b/m, 'untouched items still match');
    assert.match(rerun.stdout, /RESTART REQUIRED/, 'reinstalled agent → restart instruction again');
    assert.equal(readFileSync(join(dir, 'sterling.bat'), 'utf8'), launcherBefore, 'regenerated identically');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('contradicting flags on a re-run are reported, never applied; consuming .mcp.json is left to the plugin (no sterling added; a stale entry is removed, foreign servers kept)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configBefore = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
    const rerun = init(dir, ['--stack-tags', 'python', '--project-name', 'other-name']);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /note: --stack-tags, --project-name differ\(s\) from the recorded config — NOT applied/);
    assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), configBefore, 'config untouched by contradicting flags');

    // a foreign server is preserved and NO sterling entry is added — the plugin
    // declares sterling (bound to this project via ${CLAUDE_PROJECT_DIR})
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2));
    assert.equal(init(dir).code, 0);
    let mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.other, 'foreign server preserved');
    assert.ok(!mcp.mcpServers.sterling, 'no per-project sterling entry added — the plugin declares it');

    // a STALE init-generated sterling entry (legacy per-project form) is removed; foreign kept
    const stale = { command: process.execPath, args: [join(root, 'packages', 'mcp-server', 'dist', 'main.js').replace(/\\/g, '/'), '--store', join(dir, '.sterling', 'sterling.db').replace(/\\/g, '/')] };
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, sterling: stale } }, null, 2));
    const cleaned = init(dir);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    assert.match(cleaned.stdout, /^\.mcp\.json\s+created\s+removed the redundant per-project sterling entry/m);
    mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.other, 'foreign server preserved through cleanup');
    assert.ok(!mcp.mcpServers.sterling, 'stale init-generated sterling entry removed');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('init notes the project in the shared registry (decision 8f9e6db2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^project registry\s+created\s+noted 'ensure-target'/m);
    const reg = new ProjectRegistry(join(dir, 'registry.db'));
    try {
      const me = reg.list().find((p) => p.repo_path === dir.replace(/\\/g, '/'));
      assert.ok(me, 'this project is registered, keyed by its absolute POSIX repo path');
      assert.equal(me.name, 'ensure-target');
      assert.deepEqual(me.stack_tags, ['node']);
      assert.deepEqual(me.toolchains, ['node']);
      assert.equal(me.first_init_at, me.last_init_at, 'fresh init: first_init_at == last_init_at');
      assert.equal(me.last_seen_at, null, 'no session-start touch yet');
    } finally {
      reg.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
