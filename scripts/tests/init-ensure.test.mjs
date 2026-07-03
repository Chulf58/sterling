// §12 ensure-manifest semantics: per-item verify → create absent → skip
// matching → leave-and-report hand-edited; refusal only for destructive
// actions; every manifest artifact individually regenerable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProjectRegistry, SterlingStore } from '@sterling/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// fake Windows node path so the native launcher (sterling-windows.bat) generates
// deterministically without a real Windows node on PATH (mirrors STERLING_REGISTRY_DB).
const WIN_NODE_FAKE = 'C:\\TestNode\\node-v24-win-x64\\node.exe';

function init(dir, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    // isolate the machine-global project registry to this test's temp dir, so
    // init's registration never pollutes the real ~/.sterling/registry.db; pin
    // STERLING_WIN_NODE so the native launcher generates without a real Windows node.
    env: { ...process.env, STERLING_REGISTRY_DB: join(dir, 'registry.db'), STERLING_WIN_NODE: WIN_NODE_FAKE, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const FRESH_FLAGS = ['--project-name', 'ensure-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];
// .mcp.json is NOT a per-project artifact: the plugin declares the sterling
// server (bound per-project via ${CLAUDE_PROJECT_DIR}), so a consuming project
// never gets one. Its absence is asserted directly below.
const ARTIFACTS = ['.sterling/config.json', 'CLAUDE.md', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', '.gitignore'];
const snapshot = (dir) => Object.fromEntries(ARTIFACTS.map((a) => [a, readFileSync(join(dir, a), 'utf8')]));

test('init records a Windows-drive --backup-path in WSL /mnt form (r-dd88 backup_path bug)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-bkp-'));
  try {
    // A Windows-form backup path is how pre-WSL-migration configs were recorded.
    // Under WSL it must be stored as /mnt/<d>/... so dispose-run resolves it
    // absolute, not as a junk relative dir inside the repo (resolve treats
    // 'C:/...' as relative on POSIX). On native Windows the drive path is kept.
    const r = init(dir, ['--project-name', 'bkp', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'C:/Users/test/.sterling-backups/bkp']);
    assert.equal(r.code, 0, r.stderr);
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    const expected = process.platform === 'win32' ? 'C:/Users/test/.sterling-backups/bkp' : '/mnt/c/Users/test/.sterling-backups/bkp';
    assert.equal(config.backup_path, expected, 'Windows drive backup_path recorded in the runtime-correct form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(config.stack_tags, ['node', 'sterling'], 'fresh init gets the universal sterling domain on top of declared tags (decision 47be4388)');
    // native-Windows launcher (sterling-windows.bat): fully native, generated from the fake win-node
    assert.match(r.stdout, /^sterling-windows\.bat\s+created\b/m);
    const nat = readFileSync(join(dir, 'sterling-windows.bat'), 'utf8');
    assert.match(nat, /%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt\.exe/, 'calls wt by absolute WindowsApps path');
    assert.match(nat, /%USERPROFILE%\\\.local\\bin\\claude\.exe" --plugin-dir/, 'left pane runs native claude with --plugin-dir');
    assert.ok(nat.includes(`"${WIN_NODE_FAKE}"`), 'right pane runs the detected Windows node (quoted)');
    assert.match(nat, /--size 0\.35\b/, 'wt split uses a 0–1 float, not a percent');
    assert.ok(!/35%/.test(nat), 'native launcher does NOT use the tmux percent unit');
    // option B: native claude loads the Windows MCP config and strictly ignores the plugin's WSL server
    assert.match(nat, /--mcp-config "[^"]*\\\.claude-plugin\\sterling-mcp-win\.json" --strict-mcp-config/, 'native claude loads the Windows MCP config strictly');

    // --- P5: the domain-knowledge snapshot bridge (AC8) -------------------
    // A native-Windows process cannot live-read the WSL-resident WAL domain
    // stores (research_finding 5c6437d8: WAL-over-9p `database is locked`). The
    // native launcher first refreshes a VACUUM-INTO snapshot of each WSL domain
    // store into the Windows-local default path via a WSL-side run of
    // `node snapshot-domains-for-windows.mjs`, THEN launches the native panes
    // that open those snapshots read-only.
    //
    // P5 REWORK: the prior assertion `assert.ok(!/wsl\.exe/.test(nat), …)` is
    // intentionally REPLACED — P5 introduces EXACTLY ONE wsl.exe usage (the
    // snapshot step). The assertions below pin that the only wsl.exe IS the
    // snapshot step and that the claude / TUI panes themselves remain native.
    const crlfLines = nat.split('\r\n'); // CRLF split — every .bat statement line
    const wslLines = crlfLines.filter((l) => /wsl\.exe/.test(l));
    assert.equal(wslLines.length, 1, 'P5 introduces EXACTLY ONE wsl.exe usage — the snapshot step, and no more');
    const snapLine = wslLines[0];
    // CRLF preserved: the wsl.exe step was found by splitting on \r\n, proving
    // the snapshot line is CRLF-terminated like the rest of the .bat.
    assert.ok(nat.includes('\r\n'), 'native launcher keeps CRLF line endings');
    assert.ok(!/[^\r]\n/.test(nat), 'no bare LF — every line ending is CRLF');

    // wsl.exe is called BARE — it lives in System32, reliably on PATH
    // (anti_pattern e7a46e35); unlike wt.exe it must NOT be given an absolute path.
    assert.match(snapLine, /(^|[^\\\w])wsl\.exe\b/, 'wsl.exe is invoked BARE (relies on PATH)');
    assert.ok(!/[A-Za-z]:\\[^\n]*wsl\.exe/.test(snapLine), 'wsl.exe is NOT given a drive-absolute path');
    assert.ok(!/%[^%\n]+%\\[^\n]*wsl\.exe/.test(snapLine), 'wsl.exe is NOT given an env-var-rooted absolute path (cf. wt.exe via %LOCALAPPDATA%)');

    // the snapshot step runs node on the snapshot script (resolved on the WSL side)
    assert.match(snapLine, /\bnode\b/, 'the snapshot step runs node inside WSL');
    assert.match(snapLine, /snapshot-domains-for-windows\.mjs/, 'the wsl.exe step runs the snapshot script');

    // positioned BEFORE the wt.exe native launch
    const snapIdx = crlfLines.findIndex((l) => /wsl\.exe/.test(l));
    const wtIdx = crlfLines.findIndex((l) => /wt\.exe/.test(l));
    assert.ok(snapIdx >= 0 && wtIdx >= 0, 'both the snapshot step and the wt launch are present');
    assert.ok(snapIdx < wtIdx, 'snapshot refresh runs BEFORE the wt.exe native launch');

    // the panes themselves remain NATIVE — wsl.exe never wraps claude.exe nor the
    // Windows-node TUI (the single wsl.exe line is the snapshot step, nothing more).
    assert.ok(!/wsl\.exe[^\r\n]*claude\.exe/.test(nat), 'claude pane is native — never wrapped by wsl.exe');
    const winNodeRe = new RegExp('wsl\\.exe[^\\r\\n]*' + WIN_NODE_FAKE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.ok(!winNodeRe.test(nat), 'the Windows-node TUI pane is native — never wrapped by wsl.exe');

    // FAIL-SOFT: a snapshot failure must NOT prevent the native panes launching.
    // The snapshot is a SEPARATE statement, not a hard `&&` gate onto the launch.
    assert.ok(!/wsl\.exe[^\r\n]*&&[^\r\n]*wt\.exe/.test(nat), 'snapshot+launch are not chained with && on one line (fail-soft)');
    assert.ok(!/&&\s*$/.test(snapLine), 'the snapshot line does not && the launch onto its own success (fail-soft)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('native launcher SKIPPED loudly when no Windows node is resolvable (P5), without blocking init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    // STERLING_WIN_NODE='' forces the no-node path regardless of the machine's Windows PATH
    const r = init(dir, FRESH_FLAGS, { STERLING_WIN_NODE: '' });
    assert.equal(r.code, 0, r.stderr); // the rest of init still completes
    assert.match(r.stdout, /^sterling-windows\.bat\s+skipped\b/m, 'reports skipped, not silently absent');
    assert.match(r.stdout, /add the node dir to the Windows PATH/, 'skip reason is actionable');
    assert.ok(!existsSync(join(dir, 'sterling-windows.bat')), 'no native launcher written when node is unresolved');
    // the WSL launcher and the rest are unaffected
    assert.ok(existsSync(join(dir, 'sterling.bat')), 'WSL launcher still generated');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init completed the rest of the manifest');
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
    for (const item of ['\\.sterling/config\\.json', 'CLAUDE\\.md', 'sterling\\.bat', 'sterling-windows\\.bat', 'tui\\.bat', 'sterling-launch\\.sh', '\\.mcp\\.json', '\\.gitignore']) {
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

test('universal sterling domain: a config lacking it gains it on re-init (refreshed), hand-tunings preserved (decision 47be4388)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    // simulate a project init'd by older code: strip the universal tag, AND tune a field
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.stack_tags = cfg.stack_tags.filter((t) => t !== 'sterling'); // → ['node']
    cfg.caps.inner_loop_n = 7; // a hand-tuning that MUST survive the managed add
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\s+added the universal 'sterling' domain/m);
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.stack_tags, ['node', 'sterling'], 'sterling appended; declared tag kept');
    assert.equal(after.caps.inner_loop_n, 7, 'hand-tuning preserved — managed add, not regenerate-from-defaults');
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
      assert.deepEqual(me.stack_tags, ['node', 'sterling'], 'declared tag + the auto-injected universal sterling domain (decision 47be4388)');
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

// =============================================================================
// Phase 2 (r-ea9e) — config.models wiring end-to-end through init.
//
// init writes .sterling/config.json (carrying config.models, shipped defaults),
// THEN installs the agents; the phase goal requires init to thread that PARSED
// CONFIG through the render path so {{MODEL}}/{{EFFORT}} resolve per agent via
// AGENT_MODEL_KEY. Observable contract: every installed agent frontmatter carries
// a CONCRETE pinned model/effort (no surviving token), and coder resolves to the
// shipped-default coder model — proving config.models is authoritative at install.
// =============================================================================

test('phase-2 wiring: fresh init resolves {{MODEL}}/{{EFFORT}} in the installed agents from its own config.models (no token survives; concrete pinned ids)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);

    // config.models is present and pinned in the config init just wrote.
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.ok(config.models && config.models.coder, 'init wrote config.models with a coder entry');

    for (const name of ['coder.md', 'reviewer-correctness.md']) {
      const installed = readFileSync(join(dir, '.claude', 'agents', name), 'utf8');
      const fm = installed.match(/^---\n([\s\S]*?)\n---/)[1];
      assert.ok(!installed.includes('{{'), `${name}: no substitution token survives install`);
      assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, `${name}: model resolved to a concrete pinned claude- id`);
      assert.match(fm, /^effort: [a-z]+$/m, `${name}: effort resolved to a concrete value`);
    }

    // coder resolves to the shipped-default coder model — config.models is the
    // authoritative source at install (matches config.test.ts's shipped default).
    const coderFm = readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(coderFm, /^model: claude-sonnet-4-6$/m, 'coder installs on the shipped-default coder model (config.models authoritative)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// P5 — domain-knowledge snapshot bridge: scripts/snapshot-domains-for-windows.mjs
//
// AC8: the native-Windows launcher refreshes a VACUUM-INTO snapshot of each WSL
// domain store into the Windows-local default path at startup; the native TUI
// opens those read-only and shows their records (stale-as-of-launch). The WSL
// side of that bridge is this script. A native process cannot live-read the
// WSL-resident WAL stores (research_finding 5c6437d8) — so the source domain
// stores are snapshotted (VACUUM INTO, reusing SterlingStore.snapshot /
// MountedStores.snapshotAll) into the Windows-local default path read-only.
//
// CONTRACT pinned here (behavioral, via spawnSync — NEVER import: a missing
// script must yield a non-zero EXIT we assert on, never a thrown import error):
//   node scripts/snapshot-domains-for-windows.mjs \
//        --target <projectDir> --win-domains-root <destDir>
//   • reads <projectDir>/.sterling/config.json, resolves the project's mounted
//     domain stores (honoring config.domain_paths via resolveDomainMounts),
//   • for each domain store that EXISTS on disk, VACUUM-INTOs it to
//     <destDir>/<tag>/sterling.db,
//   • a domain whose SOURCE store does not exist is SKIPPED LOUDLY (reported,
//     never created, never crashes),
//   • prints a summary INCLUDING the snapshot time (staleness surfaced honestly),
//   • exits 0 on success.
// --win-domains-root is an override that exists FOR TESTABILITY; in production
// it defaults to the /mnt/c translation of the Windows homedir's ~/.sterling/domains.
// =============================================================================

const SNAPSHOT_SCRIPT = join(root, 'scripts', 'snapshot-domains-for-windows.mjs');

// envelope/record-builder mirroring packages/store/src/tests/store.test.ts so a
// seeded domain record is schema-valid and provably round-trips through the snapshot.
function envelope(type, over = {}) {
  const at = '2026-06-26T12:00:00.000Z';
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'domain:node', // a DOMAIN-scoped record, so it lives in the domain store
    stack_tags: ['node'],
    ...over,
  };
}

function domainDecision(over = {}) {
  return {
    ...envelope('decision'),
    title: 'Domain-shared decision',
    statement: 'A cross-project decision that lives in the node domain store.',
    alternatives_rejected: [{ option: 'project-only', reason: 'not shareable' }],
    rationale: 'Shared across every node project.',
    file_keys: ['packages/store/src/index.ts'],
    ...over,
  };
}

// Write a minimal, schema-valid .sterling/config.json whose `node` domain is
// path-overridden to our temp source store (all other config fields default).
function writeProject(dir, domainPaths) {
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { project_name: 'snapshot-fixture', stack_tags: Object.keys(domainPaths), domain_paths: domainPaths };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config, null, 2));
}

function runSnapshot(projectDir, destDir) {
  const r = spawnSync(process.execPath, [SNAPSHOT_SCRIPT, '--target', projectDir, '--win-domains-root', destDir], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, STERLING_REGISTRY_DB: join(projectDir, 'registry.db') },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('P5 snapshot script: VACUUM-INTOs each EXISTING domain store to <win-root>/<tag>/sterling.db; the snapshot opens read-only and returns the seeded record (AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    // a REAL source domain store with a seeded domain-scoped record
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    let seededId;
    try {
      seededId = src.create(domainDecision()).id;
    } finally {
      src.close();
    }
    writeProject(dir, { node: srcDb });

    const dest = join(dir, 'win-domains');
    const r = runSnapshot(dir, dest);
    assert.equal(r.code, 0, `snapshot script exits 0: ${r.stderr}`);

    // the snapshot landed at the Windows-local default layout <root>/<tag>/sterling.db
    const snapDb = join(dest, 'node', 'sterling.db');
    assert.ok(existsSync(snapDb), 'VACUUM-INTO snapshot written at <win-root>/node/sterling.db');

    // opening the snapshot returns the seeded domain record (provably the SAME data)
    const snap = new SterlingStore(snapDb);
    try {
      const got = snap.get(seededId);
      assert.ok(got, 'seeded domain record present in the snapshot');
      assert.equal(got.id, seededId, 'snapshot round-trips the exact record');
      assert.equal(got.type, 'decision');
    } finally {
      snap.close();
    }

    // staleness is surfaced honestly: the summary names the node domain and a time
    assert.match(r.stdout, /node/, 'summary reports the node domain that was snapshotted');
    assert.match(r.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'summary includes the snapshot time (ISO-ish) — staleness surfaced');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P5 snapshot script: a configured domain whose SOURCE db is ABSENT is SKIPPED LOUDLY — still exits 0, reports the skip, never creates that tag\'s snapshot dir (AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    // 'node' has a real source store; 'ghost' is configured but its source db is absent
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    try {
      src.create(domainDecision());
    } finally {
      src.close();
    }
    const ghostDb = join(dir, 'src-domains', 'ghost', 'sterling.db'); // intentionally NOT created
    assert.ok(!existsSync(ghostDb), 'precondition: the ghost source store does not exist');
    writeProject(dir, { node: srcDb, ghost: ghostDb });

    const dest = join(dir, 'win-domains');
    const r = runSnapshot(dir, dest);

    // a missing source is non-fatal: the script still completes
    assert.equal(r.code, 0, `missing source is non-fatal — still exits 0: ${r.stderr}`);
    // the present domain WAS snapshotted
    assert.ok(existsSync(join(dest, 'node', 'sterling.db')), 'the present node domain is still snapshotted');
    // the absent domain is SKIPPED LOUDLY: reported, and its snapshot dir never created
    assert.match(r.stdout + r.stderr, /ghost/, 'the skipped ghost domain is reported by name (loud, not silent)');
    assert.match(r.stdout + r.stderr, /skip/i, 'the report uses skip wording');
    assert.ok(!existsSync(join(dest, 'ghost')), 'no snapshot dir created for the absent source domain');
    assert.ok(!existsSync(join(dest, 'ghost', 'sterling.db')), 'no snapshot db fabricated for the absent source');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P5 snapshot script: refreshes over an existing snapshot — a second run reflects the LATEST source and still exits 0 (startup refresh, AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    let firstId, secondId;
    try {
      firstId = src.create(domainDecision({ title: 'first' })).id;
    } finally {
      src.close();
    }
    writeProject(dir, { node: srcDb });
    const dest = join(dir, 'win-domains');

    // first refresh
    assert.equal(runSnapshot(dir, dest).code, 0, 'first snapshot succeeds');

    // the source grows, then we refresh AGAIN at the next "startup"
    const src2 = new SterlingStore(srcDb);
    try {
      secondId = src2.create(domainDecision({ title: 'second' })).id;
    } finally {
      src2.close();
    }
    const r2 = runSnapshot(dir, dest);
    assert.equal(r2.code, 0, `re-running over an existing snapshot still succeeds (startup refresh): ${r2.stderr}`);

    // the refreshed snapshot reflects the LATEST source (both records present)
    const snap = new SterlingStore(join(dest, 'node', 'sterling.db'));
    try {
      assert.ok(snap.get(firstId), 'original record still present after refresh');
      assert.ok(snap.get(secondId), 'the record added before the second run is present — snapshot was refreshed, not stale-kept');
    } finally {
      snap.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
