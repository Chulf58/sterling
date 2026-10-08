// §12 ensure-manifest semantics: per-item verify → create absent → skip
// matching → leave-and-report hand-edited; refusal only for destructive
// actions; every manifest artifact individually regenerable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync, unlinkSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectRegistry } from '@sterling/store';
import { findDeadTerms } from '../lib/agent-distribution.mjs';
import { renderClaudeText } from '../lib/agent-fences.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A fake Windows node path. Init no longer reads STERLING_WIN_NODE (decision
// native-windows-launcher-retired-wsl2-only); the retired-artifact tests still set
// it, so a Windows node being named can be shown to produce no Windows artifact.
const WIN_NODE_FAKE = 'C:\\TestNode\\node-v24-win-x64\\node.exe';

const fwdPath = (p) => String(p).replace(/\\/g, '/');

// =============================================================================
// CONTAINMENT: A SUITE RUN IS NOT A DEPLOYMENT
// (anti_pattern a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree,
//  severity BLOCK — knowledge_get 37b3cb0a-2e54-4ce2-99b9-45b68d6e6e0f)
//
// init resolves the plugin MCP config's PATH through STERLING_PLUGIN_ROOT_MATCH,
// whose PRODUCTION default is the real clone (`process.env.STERLING_PLUGIN_ROOT_MATCH
// || pluginRoot`, init-impl.mjs's STERLING_PLUGIN_ROOT_MATCH resolution — moved out of
// scripts/init.mjs by the bootstrap/impl split). So a spawn that leaves the seam unset points
// init's ensure at THIS repo's OWN .claude-plugin/sterling-mcp.json — the live config
// the running session's MCP client loads. It reports 'matches' today only because the
// suite happens to run under the same interpreter recorded in that file; under nvm, CI,
// a wrapper, or any other node install the managed command-refresh would REPOINT THE
// LIVE CONFIG AT THE TEST RUNNER'S NODE, mid-session — and the codex gate would re-probe
// (spawning a real `codex login status`) on any machine whose live config has no codex
// key. Both are the recorded anti-pattern exactly: writing into the shipped location.
//
// Therefore EVERY spawn helper below defaults the seam to its OWN disposable scratch
// directory. Three properties make that default correct, and each is load-bearing:
//   1. It is NOT the --target. init's plugin-repo branch is fwd(target) ===
//      fwd(pluginRootMatch); aiming the seam at the target would flip every
//      consuming-project fixture in this file into a clone-target fixture and silently
//      invert what it pins. A fresh third directory keeps the comparison FALSE, exactly
//      as the real-clone default did — so no existing verdict changes.
//   2. It is a real, writable, per-spawn directory, disposed with the rest.
//   3. An EXPLICIT extraEnv value still wins (it is spread last). Every case that
//      deliberately exercises the clone-target arm sets the seam itself and is untouched.
// The `undefined` deletion idiom this file uses for other seams is REFUSED here (see
// the throw below): deleting this key restores the live-clone default, which is the
// defect, so it must never be reachable by copying a nearby call site's style.
// =============================================================================
const scratchPluginRoots = new Set();
function scratchPluginRoot() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-pluginroot-'));
  scratchPluginRoots.add(d);
  return d;
}
after(() => {
  for (const d of scratchPluginRoots) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// The two live artifacts whose path init derives from the plugin root. Stamped at MODULE
// LOAD (before the first test runs) and re-read by the Part H guard at the end of the
// file, so the containment claim covers the WHOLE suite run rather than one spawn.
// mtime+size, not bytes: a rewrite of a clean tree emits byte-identical output, so a
// content comparison passes while the file was in fact rewritten (a hollow pin — the
// anti-pattern's own recorded correction). ABSENT is a stamp too: creating a file that
// was not there is as much a deployment as changing one.
const LIVE_PLUGIN_ARTIFACTS = ['.claude-plugin/sterling-mcp.json', '.claude-plugin/sterling-mcp-win.json'];
const liveStamps = () => Object.fromEntries(LIVE_PLUGIN_ARTIFACTS.map((rel) => {
  try {
    const s = statSync(join(root, rel));
    return [rel, `${s.mtimeMs}:${s.size}`];
  } catch (e) {
    if (e.code === 'ENOENT') return [rel, 'ABSENT'];
    throw e;
  }
}));
const LIVE_STAMPS_AT_LOAD = liveStamps();

// Init creates every declared domain store (~/.sterling/domains/<tag>/) and refuses a new
// domain that has no description. So each spawn gets a scratch HOME, stable per target dir
// (a re-run must see the stores the first run made), and a --domain-description for every
// declared tag the case did not describe itself; the declared tags are the recorded config's
// when one exists (it wins on a re-run), else the --stack-tags argument.
const scratchHomes = new Map();
function scratchHome(dir) {
  if (!scratchHomes.has(dir)) scratchHomes.set(dir, scratchPluginRoot());
  return scratchHomes.get(dir);
}
function withDomainDescriptions(dir, args) {
  const configPath = join(dir, '.sterling', 'config.json');
  const i = args.indexOf('--stack-tags');
  const tags = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8')).stack_tags ?? []
    : i === -1 ? [] : String(args[i + 1] ?? '').split(',').filter(Boolean);
  const described = new Set(args.flatMap((a, j) => (args[j - 1] === '--domain-description' ? [a.split('=')[0]] : [])));
  const extra = tags.filter((t) => t !== 'sterling' && !described.has(t)).flatMap((t) => ['--domain-description', `${t}=test domain ${t}`]);
  return [...args, ...extra];
}

function init(dir, args = [], extraEnv = {}, { cwd = dir } = {}) {
  if ('STERLING_PLUGIN_ROOT_MATCH' in extraEnv && extraEnv.STERLING_PLUGIN_ROOT_MATCH === undefined) {
    throw new Error('init(): STERLING_PLUGIN_ROOT_MATCH must never be deleted — unset means init ensures THIS clone\'s live .claude-plugin/sterling-mcp.json (see the containment note above). Pass a scratch dir, or omit the key to take the helper default.');
  }
  const pluginRootMatch = extraEnv.STERLING_PLUGIN_ROOT_MATCH ?? scratchPluginRoot();
  // The user-level Claude config init checks for a codex server lives in
  // CLAUDE_CONFIG_DIR (Claude Code's own variable), else the real home. Default it to a
  // fresh EMPTY scratch dir so no test ever reads the developer's real ~/.claude.json
  // (determinism: "codex missing" unless a case plants one). An explicit value wins.
  const claudeConfigDir = extraEnv.CLAUDE_CONFIG_DIR ?? scratchPluginRoot();
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...withDomainDescriptions(dir, args)], {
    encoding: 'utf8',
    cwd,
    timeout: 180_000,
    // isolate the machine-global project registry to this test's temp dir, so
    // init's registration never pollutes the real ~/.sterling/registry.db.
    //
    // STERLING_CODEX_PROBE defaults to 'absent', and it became LOAD-BEARING with the containment fix above: aimed at
    // a fresh scratch plugin root, the plugin MCP config is CREATED on every spawn
    // instead of found already carrying a codex key, and init's codex gate probes
    // whenever the file lacks one. Unforced, that is a real `codex login status`
    // per test — determinism hostage to whether Codex is installed and logged in
    // on the running machine. Every case that cares about the WSL probe's outcome
    // already sets this seam explicitly, and that value still wins.
    env: {
      ...process.env,
      STERLING_REGISTRY_DB: join(dir, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch,
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HOME: scratchHome(dir),
      // a WSL2 host: claude-code.bat + opencode.bat (scripts/lib/launchers.mjs launcherHost); an explicit value wins
      STERLING_LAUNCHER_HOST: 'windows',
      ...extraEnv,
    },
  });
  // pluginRootMatch is returned as a LOCATION TO LOOK IN, never as evidence in
  // itself: it is what this helper INTENDED, and it stays correct even if the key
  // never reaches the child. Part H reads it only to find the directory it then
  // checks for the artifact the SPAWNED init actually produced. Measured this slice:
  // asserting on the returned value alone did not redden when the env line was
  // deleted (53 pass / 0 fail) — a hollow pin.
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', pluginRootMatch };
}

const FRESH_FLAGS = ['--project-name', 'ensure-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];
// .mcp.json is NOT a per-project artifact: the plugin declares the sterling
// server (bound per-project via ${CLAUDE_PROJECT_DIR}), so a consuming project
// never gets one. Its absence is asserted directly below.
const ARTIFACTS = ['.sterling/config.json', 'AGENTS.md', 'CLAUDE.md', 'claude-code.bat', 'opencode.bat', 'sterling-launch.sh', 'sterling-update.bat', '.gitignore'];
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

test('fresh init writes .claude/settings.json with "agent": "conductor" AND "autoMemoryEnabled": false, and reports both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.agent, 'conductor');
    assert.equal(settings.autoMemoryEnabled, false, 'auto-memory off (user-ruled 2026-09-28: "Write it into settings")');
    assert.match(r.stdout, /^\.claude\/settings\.json \(auto-memory off\)\s+created\b/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Board 4cefb9fb: `.sterling/*` is anchored to the repo root, so a nested .sterling/
// (a stray transient dir under scripts/, say) showed up untracked. init also writes
// `*/**/.sterling/`, which must not swallow the root's committed project.json.
test('init .gitignore: nested .sterling/ dirs stay ignored, root .sterling/project.json stays trackable, and a rerun adds the line once', () => {
  const NESTED = '*/**/.sterling/';
  const runGit = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const count = (dir, line) => readFileSync(join(dir, '.gitignore'), 'utf8').split(/\r?\n/).filter((l) => l === line).length;
  const plant = (dir) => {
    for (const rel of ['x/.sterling', 'a/b/.sterling']) {
      mkdirSync(join(dir, rel), { recursive: true });
      writeFileSync(join(dir, rel, 'transient.json'), '{}');
    }
  };
  const assertIgnoreSemantics = (dir, label) => {
    const porcelain = runGit(dir, ['status', '--porcelain', '--untracked-files=all']).stdout;
    assert.doesNotMatch(porcelain, /x\/\.sterling|a\/b\/\.sterling/, `${label}: no nested .sterling path is untracked:\n${porcelain}`);
    assert.match(porcelain, /^\?\? \.sterling\/project\.json$/m, `${label}: the root identity file is still trackable (untracked, not ignored):\n${porcelain}`);
    for (const ignored of ['x/.sterling/transient.json', 'a/b/.sterling/transient.json']) {
      assert.equal(runGit(dir, ['check-ignore', '-q', ignored]).status, 0, `${label}: ${ignored} is ignored`);
    }
    assert.equal(runGit(dir, ['check-ignore', '-q', '.sterling/project.json']).status, 1, `${label}: .sterling/project.json is not ignored`);
    assert.equal(runGit(dir, ['check-ignore', '-q', '.sterling/sterling.db']).status, 0, `${label}: the rest of the root .sterling/ is ignored`);
  };

  // fresh project: init writes the whole entry set.
  const fresh = mkdtempSync(join(tmpdir(), 'sterling-nested-ignore-'));
  // a project init'd before the identity file: the legacy `.sterling/` line is rewritten, the nested line added.
  const legacy = mkdtempSync(join(tmpdir(), 'sterling-nested-ignore-'));
  // a project that already carries all three lines (this repo's own form): left alone.
  const carrying = mkdtempSync(join(tmpdir(), 'sterling-nested-ignore-'));
  const dirs = [[fresh, 'fresh'], [legacy, 'legacy'], [carrying, 'carrying']];
  try {
    writeFileSync(join(legacy, '.gitignore'), 'node_modules/\n.sterling/\n');
    writeFileSync(join(carrying, '.gitignore'), `.sterling/*\n!.sterling/project.json\n${NESTED}\n`);
    for (const [dir] of dirs) {
      assert.equal(runGit(dir, ['init', '-q']).status, 0);
      plant(dir);
      const r = init(dir, FRESH_FLAGS);
      assert.equal(r.code, 0, r.stderr);
    }
    for (const [dir, label] of dirs) {
      assert.equal(count(dir, NESTED), 1, `${label}: the nested line is present once`);
      assert.equal(count(dir, '.sterling/*'), 1, `${label}: the root star line is present once`);
      assertIgnoreSemantics(dir, label);
    }
    assert.equal(count(legacy, '.sterling/'), 0, 'legacy: the directory form was rewritten');
    assert.ok(readFileSync(join(carrying, '.gitignore'), 'utf8').startsWith(`.sterling/*\n!.sterling/project.json\n${NESTED}\n`), 'carrying: the existing lines were left where they were');

    for (const [dir] of dirs) {
      const before = readFileSync(join(dir, '.gitignore'), 'utf8');
      const r = init(dir, FRESH_FLAGS);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), before, 'a second init leaves .gitignore byte-identical');
      assert.equal(count(dir, NESTED), 1, 'the nested line is still present once');
    }
  } finally {
    for (const [dir] of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure outcome 1 — create absent: fresh init creates every manifest item and records declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    for (const a of [...ARTIFACTS, '.sterling/sterling.db', '.sterling/runs', 'docs/briefs', '.claude/agents/librarian.md']) {
      assert.ok(existsSync(join(dir, a)), `created ${a}`);
    }
    // a consuming project gets NO per-project .mcp.json — the plugin declares sterling
    assert.ok(!existsSync(join(dir, '.mcp.json')), 'no per-project .mcp.json — the plugin declares the sterling server');
    assert.match(r.stdout, /^\.mcp\.json\s+matches\s+not written — the plugin declares sterling/m);
    // init never manages .claude/settings.local.json (decision foreign_097851ed, refined): the MCP
    // dual-role is gone (the plugin declares its server via plugin.json mcpServers, not a root
    // .mcp.json), so no enable-flag enforcement is needed — a consuming project keeps its own.
    assert.ok(!existsSync(join(dir, '.claude', 'settings.local.json')), 'consuming project: settings.local.json left to the user (init never writes it)');
    assert.match(r.stdout, /^AGENTS\.md\s+created\b/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m);
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m);
    // AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
    // 161e2972): CLAUDE.md is exactly the one-line import plus the Sterling layer; the
    // tool-agnostic content (project facts, conventions) renders into AGENTS.md instead.
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /^@AGENTS\.md\n/, 'CLAUDE.md opens with the @AGENTS.md import');
    // One source with host blocks (decision sterling-layer-is-one-source-with-host-blocks):
    // CLAUDE.md is the template's Claude render, with no fence marker and no OpenCode text.
    assert.equal(claudeMd, renderClaudeText(readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8'), 'target-claude-md.md').replaceAll('{{PROJECT_NAME}}', 'ensure-target'));
    assert.doesNotMatch(claudeMd, /<!-- \/?(claude|opencode)-only -->|READY FOR NEW SESSION|\{\{STERLING_ROOT\}\}/);
    assert.match(agentsMd, /^# AGENTS\.md — ensure-target\n/, 'AGENTS.md renders the project name');
    assert.ok(agentsMd.includes('Stack tags (= domain mount manifest): node, sterling'), 'AGENTS.md carries the project facts');
    // No registered adapter declares a lint or format command, so the fact line asks for one.
    assert.match(agentsMd, /^- Lint\/format command: not recorded yet; add it here$/m, 'AGENTS.md has a place for the lint/format command');
    assert.match(agentsMd, /^- \*\*Lint and tests before done\.\*\* .*Red lint is a blocker, not a note\./m, 'AGENTS.md carries the lint rule');
    assert.ok(!agentsMd.includes('- **Canonical naming:**'), 'the registries naming bullet is not rendered');
    assert.ok(!agentsMd.includes('exit code can read as a crash'), 'the test-runner exit-code bullet is not rendered');
    assert.ok(!claudeMd.includes('{{'), 'no unresolved placeholder survives in CLAUDE.md');
    assert.ok(!agentsMd.includes('{{'), 'no unresolved placeholder survives in AGENTS.md');
    assert.match(r.stdout, /RESTART REQUIRED/, 'agents installed → restart instruction');
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(config.project_name, 'ensure-target', 'project name recorded for flagless re-runs');
    assert.ok(config.backup_path.endsWith('/backups'), 'backup path recorded absolute, forward slashes');
    assert.deepEqual(config.stack_tags, ['node', 'sterling'], 'fresh init gets the universal sterling domain on top of declared tags (decision 47be4388)'); // not-a-citation: fixture id
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('lint/format fact line: a toolchain whose recorded run commands include lint and format renders them; an existing AGENTS.md is left as the project wrote it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    Object.assign(config.toolchains[0].run_commands, { lint: 'npx eslint .', format: 'npx prettier --check .' });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const kept = readFileSync(join(dir, 'AGENTS.md'), 'utf8').replace('not recorded yet; add it here', '`ruff check .`');
    writeFileSync(join(dir, 'AGENTS.md'), kept);
    assert.equal(init(dir).code, 0);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), kept, 'a command the project recorded by hand survives a re-run');

    // Both files go: a CLAUDE.md with no AGENTS.md beside it is the migration case.
    rmSync(join(dir, 'AGENTS.md'));
    rmSync(join(dir, 'CLAUDE.md'));
    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /^- Lint\/format command: `npx eslint \.` \(node\); `npx prettier --check \.` \(node\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('lint/format fact line: a recorded command with a newline or a backtick renders as one line under Project facts, with no new heading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    Object.assign(config.toolchains[0].run_commands, { lint: 'npx eslint .\n\n## Forged\n  heading', format: 'echo `date`' });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    rmSync(join(dir, 'AGENTS.md'));
    rmSync(join(dir, 'CLAUDE.md'));
    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('\n- Lint/format command: `npx eslint . ## Forged heading` (node); echo `date` (node)\n'), 'whitespace collapses to single spaces; a command with a backtick is plain text');
    assert.doesNotMatch(agentsMd, /^## Forged/m, 'a recorded command never opens a heading');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Decision native-windows-launcher-retired-wsl2-only: init never writes
// sterling-windows.bat, even with a resolvable Windows node; an existing one is
// left on disk for the user to delete, and the report says so.
test('retired native launcher: init writes no sterling-windows.bat even with a Windows node resolvable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_WIN_NODE: WIN_NODE_FAKE });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'sterling-windows.bat')), 'no native launcher is generated');
    assert.ok(!/^sterling-windows\.bat\b/m.test(r.stdout), 'no report row for a launcher that does not exist');
    // CONTROL: the WSL launchers the ruling keeps are still generated.
    assert.ok(existsSync(join(dir, 'claude-code.bat')), 'CONTROL: the WSL Claude Code launcher is generated');
    assert.ok(existsSync(join(dir, 'opencode.bat')), 'CONTROL: the WSL OpenCode launcher is generated');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('retired native launcher: an existing sterling-windows.bat is left byte-identical and reported as retired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const bat = join(dir, 'sterling-windows.bat');
    const body = '@echo off\r\nrem an old native launcher\r\n';
    writeFileSync(bat, body);
    const r = init(dir, []);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(bat, 'utf8'), body, 'the existing file is neither deleted nor rewritten');
    const line = statusLineFor(r.stdout, 'sterling-windows.bat') ?? '';
    assert.match(line, /^sterling-windows\.bat\s+stale\b/, `reported, not silent — got: ${line}`);
    assert.match(line, /retired/, 'the report says the launcher is retired');
    assert.match(line, /delete/i, 'the report tells the user they may delete it');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Decision launchers-consolidated-to-claude-code-and-opencode-pair: one engine
// (sterling-launch.sh) plus claude-code + opencode openers per host. sterling.bat and
// tui.bat are no longer generated; a copy an earlier init wrote is reported stale.
test('launchers: a Windows (WSL2) host gets claude-code.bat + opencode.bat, a native Linux host claude-code.sh + opencode.sh; neither gets sterling.bat or tui.bat', () => {
  for (const [host, own, other] of [['windows', ['claude-code.bat', 'opencode.bat'], ['claude-code.sh', 'opencode.sh']], ['linux', ['claude-code.sh', 'opencode.sh'], ['claude-code.bat', 'opencode.bat']]]) {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
    try {
      const r = init(dir, FRESH_FLAGS, { STERLING_LAUNCHER_HOST: host });
      assert.equal(r.code, 0, r.stderr);
      for (const f of ['sterling-launch.sh', ...own]) {
        assert.ok(existsSync(join(dir, f)), `${host}: ${f} generated`);
        assert.match(statusLineFor(r.stdout, f) ?? '', new RegExp(`^${escapeRe(f)}\\s+created\\b`), `${host}: ${f} reported`);
      }
      for (const f of [...other, 'sterling.bat', 'tui.bat']) assert.ok(!existsSync(join(dir, f)), `${host}: no ${f}`);
      const ignored = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
      for (const e of ['sterling-launch.sh', 'claude-code.bat', 'opencode.bat', 'claude-code.sh', 'opencode.sh', 'sterling.bat', 'tui.bat', 'sterling-windows.bat']) {
        assert.ok(ignored.includes(e), `${host}: .gitignore carries ${e}`);
      }
      if (host === 'linux') {
        for (const f of ['sterling-launch.sh', ...own]) assert.equal(statSync(join(dir, f)).mode & 0o111, 0o111, `${f} is executable`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

test('launchers: an existing sterling.bat and tui.bat are left byte-identical and reported stale, naming what replaces them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const old = { 'sterling.bat': '@echo off\r\nrem an old launcher\r\n', 'tui.bat': '@echo off\r\nrem an old TUI re-opener\r\n' };
    for (const [f, body] of Object.entries(old)) writeFileSync(join(dir, f), body);
    const r = init(dir, []);
    assert.equal(r.code, 0, r.stderr);
    for (const [f, body] of Object.entries(old)) {
      assert.equal(readFileSync(join(dir, f), 'utf8'), body, `${f} is neither deleted nor rewritten`);
      assert.match(statusLineFor(r.stdout, f) ?? '', new RegExp(`^${escapeRe(f)}\\s+stale\\b.*no longer generates it`), `${f} reported stale`);
    }
    assert.match(statusLineFor(r.stdout, 'sterling.bat'), /claude-code\.bat and opencode\.bat replace it/);
    assert.match(statusLineFor(r.stdout, 'tui.bat'), /re-adds a closed TUI pane/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('launchers: an unknown STERLING_LAUNCHER_HOST stops init loudly, before anything is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_LAUNCHER_HOST: 'macos' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /STERLING_LAUNCHER_HOST must be 'windows' or 'linux' \(got 'macos'\)/);
    assert.ok(!existsSync(join(dir, '.sterling')) && !existsSync(join(dir, 'sterling-launch.sh')), 'refused in the verify pass, before any write');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Decision native-windows-launcher-retired-wsl2-only, applied to its companion:
// .claude-plugin/sterling-mcp-win.json existed only for the retired launcher's
// --mcp-config, so init no longer generates it, even in the plugin repo with a
// Windows node resolvable; an existing one is left on disk and reported retired.
test('retired win MCP config: init writes no sterling-mcp-win.json even in the plugin repo with a Windows node resolvable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_WIN_NODE: WIN_NODE_FAKE });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json')), 'no win MCP config is generated');
    assert.ok(!/^\.claude-plugin\/sterling-mcp-win\.json\b/m.test(r.stdout), 'no report row for a file that does not exist');
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp.json')), 'init no longer generates the plugin MCP config (it is committed, slice S2)');
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.claude-plugin\/sterling-mcp-win\.json$/m, 'CONTROL: the plugin-root gate is open — the clone-target branch ran (its plugin-repo-only .gitignore entry is present)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('retired win MCP config: an existing sterling-mcp-win.json is left byte-identical and reported as retired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir }).code, 0);
    const win = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    mkdirSync(dirname(win), { recursive: true });
    const body = '{"mcpServers":{"sterling":{"command":"C:\\\\old\\\\node.exe"}}}';
    writeFileSync(win, body);
    const r = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(win, 'utf8'), body, 'the existing file is neither deleted nor rewritten');
    const line = statusLineFor(r.stdout, '.claude-plugin/sterling-mcp-win.json') ?? '';
    assert.match(line, /^\.claude-plugin\/sterling-mcp-win\.json\s+stale\b/, `reported, not silent — got: ${line}`);
    assert.match(line, /retired/, 'the report says the file is retired');
    assert.match(line, /delete/i, 'the report tells the user they may delete it');
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
    for (const item of ['\\.sterling/config\\.json', 'CLAUDE\\.md', 'claude-code\\.bat', 'opencode\\.bat', 'sterling-launch\\.sh', 'sterling-update\\.bat', '\\.mcp\\.json', '\\.gitignore']) {
      assert.match(rerun.stdout, new RegExp(`^${item}\\s+matches\\b`, 'm'), `${item} reported as matching`);
    }
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+matches\b/m);
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
    tuned.delegation.max_concurrent = 7;
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));
    appendFileSync(join(dir, 'CLAUDE.md'), '\n## Local additions\n- the human wrote this\n');
    appendFileSync(join(dir, '.claude', 'agents', 'librarian.md'), '\nlocal tweak\n');
    const before = snapshot(dir);
    const agentBefore = readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+differs\s+left untouched/m);
    assert.match(rerun.stdout, /^AGENTS\.md\s+ok\s+present — project-editable, never compared byte-for-byte/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the Sterling layer by hand/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+differs\s+locally modified/m);
    assert.deepEqual(snapshot(dir), before, 'hand-edited files untouched');
    assert.equal(readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8'), agentBefore, 'modified agent untouched');
    // tuned declarations still drive the run: delegation came from the recorded config
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).delegation.max_concurrent, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('universal sterling domain: a config lacking it gains it on re-init (refreshed), hand-tunings preserved (decision foreign_47be4388)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    // simulate a project init'd by older code: strip the universal tag, AND tune a field
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.stack_tags = cfg.stack_tags.filter((t) => t !== 'sterling'); // → ['node']
    cfg.delegation.max_concurrent = 7; // a hand-tuning that MUST survive the managed add
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\s+added the universal 'sterling' domain/m);
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.stack_tags, ['node', 'sterling'], 'sterling appended; declared tag kept');
    assert.equal(after.delegation.max_concurrent, 7, 'hand-tuning preserved — managed add, not regenerate-from-defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('never-clobber: a pre-existing hand-written CLAUDE.md survives the FIRST init byte-for-byte; AGENTS.md is reported manual, not guessed; init completes around both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const ownContract = '# My project\n\nHand-written build contract. Sacred.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), ownContract);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `init completes around the existing CLAUDE.md, no refusal: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), ownContract, 'NEVER clobbered');
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'AGENTS.md never guessed into existence from an unrecognized head');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render of the Sterling template \(checked \d+ revision\(s\)\) — nothing written/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+left untouched pending AGENTS\.md migration/m);
    for (const a of ['.sterling/config.json', '.sterling/sterling.db', 'claude-code.bat', '.claude/agents/librarian.md']) {
      assert.ok(existsSync(join(dir, a)), `the rest of the manifest still created: ${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer): a legacy full CLAUDE.md beside an ALREADY-PRESENT AGENTS.md (e.g. a gitignored Codex-derived copy, unrelated to a real migration) is reported manual for BOTH rows — never silently treated as an interrupted-run continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const foreignAgentsMd = '# AGENTS.md\n\n<!-- identical to CLAUDE.md -->\n\nsome pre-existing content, not a real Sterling migration\n';
    writeFileSync(join(dir, 'AGENTS.md'), foreignAgentsMd);
    const legacy = legacyMonolithClaudeMd('ensure-target', '- a project convention.\n');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), foreignAgentsMd, 'AGENTS.md untouched — nothing written (it does NOT byte-match what migration would produce)');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), legacy, 'CLAUDE.md untouched — nothing written');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+legacy CLAUDE\.md beside an existing AGENTS\.md/m, 'AGENTS.md reported manual, not ok');
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+legacy CLAUDE\.md beside an existing AGENTS\.md/m, 'CLAUDE.md reported manual, not differs');
    assert.match(r.stdout, /Codex-derived copy of CLAUDE\.md \(gitignored, header 'identical to CLAUDE\.md'\), delete it and rerun/, 'the loud reason names the Codex-derived-copy remedy');
    const previewPath = join(dir, '.sterling', 'agents-md-migration-preview.diff');
    assert.ok(existsSync(previewPath), 'the same migration preview diff other manual branches write is written here too');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer), control arm: a STUB CLAUDE.md (already the @AGENTS.md import — a genuine prior migration) beside an existing AGENTS.md is UNCHANGED behaviour — AGENTS.md ok, CLAUDE.md matches, both byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const realAgentsMd = '# AGENTS.md — ensure-target\n\nreal, previously migrated content\n';
    writeFileSync(join(dir, 'AGENTS.md'), realAgentsMd);
    const stubClaudeMd = renderClaudeText(readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8'), 'target-claude-md.md').replaceAll('{{PROJECT_NAME}}', 'ensure-target');
    assert.equal(stubClaudeMd.split(/\r?\n/, 1)[0], '@AGENTS.md', 'fixture sanity: this IS the stub form');
    writeFileSync(join(dir, 'CLAUDE.md'), stubClaudeMd);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+ok\b/m, 'unchanged behaviour: AGENTS.md still ok, never manual');
    assert.match(r.stdout, /^CLAUDE\.md\s+matches\b/m, 'CLAUDE.md compared byte-for-byte and matches — never manual, never rewritten');
    assert.ok(!/^AGENTS\.md\s+manual/m.test(r.stdout), 'never manual when CLAUDE.md is already the stub');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md left untouched — byte-identical, never compared');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), stubClaudeMd, 'CLAUDE.md left untouched — byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer), CRLF stub recognition: a CRLF stub CLAUDE.md is still recognized as already-migrated (first line is @AGENTS.md regardless of its own EOL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const realAgentsMd = '# AGENTS.md — ensure-target\r\n\r\nreal, previously migrated content\r\n';
    writeFileSync(join(dir, 'AGENTS.md'), realAgentsMd);
    const stubClaudeMd = renderClaudeText(readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8'), 'target-claude-md.md').replaceAll('{{PROJECT_NAME}}', 'ensure-target').replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'CLAUDE.md'), stubClaudeMd);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/^AGENTS\.md\s+manual/m.test(r.stdout), 'a CRLF stub is still recognized — never manual');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — interrupted-run continuation: AGENTS.md already holds exactly what migration would write, CLAUDE.md is still legacy → only CLAUDE.md is rewritten, reported migrated (resumed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '- Ship on Tuesdays only.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    // First run: a real, successful migration produces the real AGENTS.md.
    const first = init(dir, FRESH_FLAGS);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^AGENTS\.md\s+migrated\b/m);
    const realAgentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    // Simulate an interrupted run: the AGENTS.md write landed but the CLAUDE.md write never did —
    // CLAUDE.md reverts to its legacy form, AGENTS.md keeps its real migrated content.
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const second = init(dir);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^AGENTS\.md\s+ok\s+already present — byte-identical to what migration would write; treated as an interrupted run, resumed/m);
    assert.match(second.stdout, /^CLAUDE\.md\s+migrated \(resumed\)/m);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md untouched, byte-identical');
    assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md\n/, 'CLAUDE.md rewritten as the fresh Sterling-layer import');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// A real legacy pre-split CLAUDE.md, as init generated it before this project committed the
// AGENTS.md/CLAUDE.md split — rendered from a REAL historical (git-committed) revision of the
// monolithic templates/target-claude-md.md, the same source historicalHeadSegmentSets() in
// init-impl.mjs walks. NOT pinned to HEAD (Sol re-check finding 1): once the split lands, HEAD
// IS the split template and carries no {{CONVENTIONS_SECTION}} at all, so `git show HEAD:...`
// would silently stop testing anything. Instead walk `git log` NEWEST FIRST and take the first
// blob that still contains the {{CONVENTIONS_SECTION}} token — the same selection
// historicalHeadSegmentSets() makes for a real legacy project — and fail loudly if none exists.
// NO MARKER: the tail is whatever the project wrote where {{CONVENTIONS_SECTION}} was — nothing
// more is required of it (Sol re-spec, corrected after Dome Farmer's tail turned out to be a
// hand-written bold ruling, not a Sterling-emitted marker line).
function pristineMonolithBlob() {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'templates/target-claude-md.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(log.status, 0, `git log -- templates/target-claude-md.md: ${log.stderr}`);
  const shas = log.stdout.split('\n').filter(Boolean);
  for (const sha of shas) {
    const show = spawnSync('git', ['show', `${sha}:templates/target-claude-md.md`], { cwd: root, encoding: 'utf8' });
    if (show.status !== 0) continue;
    if (show.stdout.includes('{{CONVENTIONS_SECTION}}')) return { sha, text: show.stdout };
  }
  assert.fail('no historical revision of templates/target-claude-md.md contains {{CONVENTIONS_SECTION}} — the fixture has nothing pre-split to render from');
}
function legacyMonolithClaudeMd(projectName, tail, opts = {}) {
  const { sha, text } = pristineMonolithBlob();
  // PROOF this is picking a genuinely OLD blob, not silently falling back to the working tree
  // (Sol re-check finding 1): post-split, the working-tree template carries no
  // {{CONVENTIONS_SECTION}} at all, so the chosen historical blob MUST differ from it.
  const workingTree = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
  assert.notEqual(text, workingTree, `chosen historical blob (${sha}) must differ from the current working-tree template, which is the post-split one`);
  const filled = text
    .replaceAll('{{PROJECT_NAME}}', projectName)
    .replaceAll('{{STACK_TAGS}}', opts.stackTags ?? 'node, sterling')
    .replaceAll('{{TOOLCHAINS}}', opts.toolchains ?? 'node (**/*.mjs)')
    .replaceAll('{{DOMAINS}}', opts.domains ?? '~/.sterling/domains/node/, ~/.sterling/domains/sterling/ — created lazily on first need (§2.3)')
    .replaceAll('{{BACKUP_PATH}}', opts.backupPath ?? 'configured — see `.sterling/config.json` → `backup_path` (machine-local, deliberately not restated here)');
  assert.ok(filled.includes('{{CONVENTIONS_SECTION}}'), 'fixture sanity: the conventions placeholder is still there to replace');
  const eol = opts.eol ?? '\n';
  const body = filled.replace('{{CONVENTIONS_SECTION}}', tail);
  return eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
}

test('real-world gap (Dome Farmer): a legacy tail containing a dead-term word ("wave", as in enemy waves — project prose, not Sterling\'s retired codename) migrates cleanly; the dead-term lint never judges project text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET, NEVER ABOUT STERLING** (user ruling).\n\n- Balance the next wave of enemies before shipping; a wave that spikes too hard is a defect.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `must not crash on a project's own "wave" text: ${r.stderr}`);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m, 'migration proceeds — the tail is exempt from the dead-term lint');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\b/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes(tail), 'the tail carrying "wave" is byte-identical, untouched by the lint');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('dead-term lint still fails loudly on the TEMPLATE\'s own prose (unit-tested against the shared findDeadTerms helper init-impl.mjs\'s assertNoDeadTerms wraps: the real templates/target-agents-md.md and templates/target-claude-md.md heads are asserted clean, and a planted codename is still caught by the same function)', () => {
  // init resolves its own plugin root from import.meta.url, not from any env seam this test
  // harness exposes, so pointing a live init run at a doctored template dir is not available
  // here (documented, per the brief) — this covers the exact function init-impl.mjs's
  // assertNoDeadTerms wraps, against both the real shipped template text (must stay clean) and a
  // planted dead term (must be caught), rather than reimplementing the check's logic.
  const agentsTemplate = readFileSync(join(root, 'templates', 'target-agents-md.md'), 'utf8');
  const claudeTemplate = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
  assert.deepEqual(findDeadTerms(agentsTemplate), [], 'the real AGENTS.md template is currently clean');
  assert.deepEqual(findDeadTerms(claudeTemplate), [], 'the real CLAUDE.md template is currently clean');
  const doctored = agentsTemplate.replace('## Core principles', '## Core principles — brought to you by the Forge codename\n');
  const hits = findDeadTerms(doctored);
  assert.ok(hits.length > 0 && hits.some((h) => h.term === 'Forge'), 'a dead term planted in TEMPLATE prose is still caught');
});

test('boundary fix (Sol re-check): a historical head with an EXTRA LINE inserted right after a placeholder value (before the next literal) is refused as manual — never silently absorbed into the placeholder and migrated with that line lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    // Insert an extra line immediately after the rendered {{PROJECT_NAME}} value (the FIRST
    // placeholder in the template head) — indexOf-without-a-newline-guard would treat that
    // inserted line as if it were part of the placeholder's own value and still match.
    const injected = '\nA HUMAN-INSERTED LINE RIGHT AFTER THE PROJECT NAME PLACEHOLDER, BEFORE THE NEXT LITERAL.';
    const legacy = legacyMonolithClaudeMd('ensure-target', '- tail\n').replace('ensure-target', `ensure-target${injected}`);
    assert.ok(legacy.includes(injected), 'fixture sanity: the injected line landed in the rendered head');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never migrated — the inserted line must not be silently absorbed and dropped');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render/m);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), legacy, 'CLAUDE.md left untouched — the inserted line is preserved because nothing was migrated');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration, Dome-Farmer-shaped: a historical head with arbitrary project facts, followed by a hand-written BOLD RULING (never a marker line) as the tail — migrates, tail byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET, NEVER ABOUT STERLING** (user ruling, 2026-09-01, verbatim: "keep this project instructions separate").\n\n- Uses `knowledge_query` before every design (mentions a Sterling tool on purpose, to prove the flag).\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated \(1 flagged\)/m, 'the knowledge_query line is flagged, migration still proceeds');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\s+re-rendered as the Sterling layer/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(agentsMd.includes(tail), 'the bold ruling tail carried byte-identical — no marker involved');
    assert.match(claudeMd, /^@AGENTS\.md\n/, 'CLAUDE.md re-rendered as the fresh Sterling-layer import');
    assert.ok(!claudeMd.includes('EVERYTHING BELOW'), 'the project-owned tail moved to AGENTS.md, not duplicated into CLAUDE.md');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — a head that does NOT match any historical template render is refused (P5): nothing written, a preview diff is left for the human', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const handTuned = legacyMonolithClaudeMd('ensure-target', '- hand tuning\n').replace('Durable conventions and project facts.', 'Durable conventions and project facts (hand-edited preamble).');
    writeFileSync(join(dir, 'CLAUDE.md'), handTuned);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never guessed a split from an unrecognized head');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), handTuned, 'CLAUDE.md left untouched');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render of the Sterling template \(checked \d+ revision\(s\)\)/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+left untouched pending AGENTS\.md migration/m);
    const previewPath = join(dir, '.sterling', 'agents-md-migration-preview.diff');
    assert.ok(existsSync(previewPath), 'a preview diff is left for the human to review');
    const preview = readFileSync(previewPath, 'utf8');
    assert.ok(preview.length > 0, 'preview diff is non-empty');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — an OLDER rendering scheme (placeholder values differing from what this project declares today) still migrates: the boundary match is on prose structure, not on today\'s facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '- an older project fact set.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail, {
      stackTags: 'python, sterling', // this project's OLD stack, before it moved to node
      toolchains: 'python (**/*.py)',
      domains: '~/.sterling/domains/python/, ~/.sterling/domains/sterling/ — created lazily on first need (§2.3)',
      backupPath: '(opted out — recorded)',
    });
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS); // FRESH_FLAGS declares node/sterling today — deliberately different
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m, 'migrates despite the value mismatch — only the prose structure had to match');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\b/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('an older project fact set.'), 'tail carried');
    assert.ok(agentsMd.includes('node, sterling'), 'AGENTS.md renders TODAY\'S facts, not the legacy ones');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — CRLF: the tail bytes are unchanged (still CRLF) and the freshly-rendered head is converted to the legacy file\'s own EOL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET** (bold ruling, not a marker).\r\n\r\n- CRLF project convention.\r\n- second line.\r\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail.replace(/\r\n/g, '\n'), { eol: '\r\n' });
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m);
    const agentsMdBytes = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMdBytes.includes(tail), 'tail carried with its ORIGINAL CRLF endings, byte-for-byte — no marker involved');
    const headPortion = agentsMdBytes.slice(0, agentsMdBytes.indexOf('⚠ **EVERYTHING BELOW'));
    assert.ok(headPortion.includes('\r\n'), 'the freshly-rendered head was converted to the legacy file\'s own CRLF convention');
    assert.ok(!/[^\r]\n/.test(headPortion), 'no bare LF survives in the head portion');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — git unavailable (no history to verify against): reported manual naming the missing history, never migrated blind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const legacy = legacyMonolithClaudeMd('ensure-target', '- tail\n');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    // Hide `git` from the CHILD init process only — makes historicalHeadSegmentSets() fail to
    // resolve any history, which must never be silently treated as "no match".
    const r = init(dir, FRESH_FLAGS, { PATH: '/nonexistent-bin-dir-for-this-test-only' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never migrated blind when history cannot be verified');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+git log failed for templates\/target-claude-md\.md/m, 'the missing-history reason is named, not folded into the generic non-matching-head message');
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
    const launcherBefore = readFileSync(join(dir, 'claude-code.bat'), 'utf8');
    unlinkSync(join(dir, 'claude-code.bat'));
    unlinkSync(join(dir, '.claude', 'agents', 'librarian.md'));

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^claude-code\.bat\s+created\b/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+created\b/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+matches\b/m, 'untouched items still match');
    assert.match(rerun.stdout, /RESTART REQUIRED/, 'reinstalled agent → restart instruction again');
    assert.equal(readFileSync(join(dir, 'claude-code.bat'), 'utf8'), launcherBefore, 'regenerated identically');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Decision gap-hunt-2026-09-28-rulings item (12): keys the schema no longer
// defines are silently ignored, so a conductor can write to a dead key with no
// warning (measured: Dome Farmer's models.coder). A re-run NAMES each by path,
// with the known rename, and never deletes one.
test('a re-run lists the config keys Sterling no longer reads, nested ones by path with their renames, and deletes none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const fresh = init(dir);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /no longer reads/, 'control: a config init wrote itself carries no dead key');
    const cfgPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.caps = { inner_loop_n: 3 };
    cfg.models.coder = { model: 'claude-sonnet-5-5', effort: 'medium' };
    cfg.models.explorer = { model: 'claude-sonnet-5-5', effort: 'low' };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const before = readFileSync(cfgPath, 'utf8');
    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /note: \.sterling\/config\.json carries 3 key\(s\) Sterling no longer reads: models\.coder \(renamed to models\.implementor\), models\.explorer \(renamed to models\.scout\), caps — /);
    assert.equal(readFileSync(cfgPath, 'utf8'), before, 'disclosure only: no key is deleted and the file is not rewritten');
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

// The plugin-repo branch (win MCP config generation) only runs when target ===
// pluginRoot, which no temp-dir fixture can reach — pin the two store-arg forms
// at the source instead. The asymmetry is deliberate (verified 2026-07-12,
// code.claude.com/docs/en/mcp): plugin-scope configs substitute
// ${CLAUDE_PROJECT_DIR} unconditionally (bare form correct), but a --mcp-config
// file gets project-scope env expansion where the var is unset at parse time —
// without the :-. default the literal passes through and the server mkdirs a
// phantom '${CLAUDE_PROJECT_DIR}/' store at its cwd (observed 2026-06-24).
// The win-config half of this test (the ${CLAUDE_PROJECT_DIR:-.} default for the
// --mcp-config file) was removed with sterling-mcp-win.json itself (decision
// native-windows-launcher-retired-wsl2-only); the plugin half still ships.
test('MCP store args: plugin config stays bare ${CLAUDE_PROJECT_DIR} (phantom-store regression)', () => {
  // The plugin entry is now the COMMITTED .claude-plugin/sterling-mcp.json (slice S2), no
  // longer generated by init-impl.mjs, so the pin reads the file that actually ships.
  const args = JSON.parse(readFileSync(join(root, '.claude-plugin', 'sterling-mcp.json'), 'utf8')).mcpServers.sterling.args;
  assert.deepEqual(
    args.slice(-2),
    ['--project', '${CLAUDE_PROJECT_DIR}'],
    'plugin-scope entry keeps the bare form — plugin configs substitute it unconditionally'
  );
});

test('init notes the project in the shared registry (decision foreign_8f9e6db2)', () => {
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
      assert.deepEqual(me.stack_tags, ['node', 'sterling'], 'declared tag + the auto-injected universal sterling domain (decision 47be4388)'); // not-a-citation: fixture id
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

// config_drift through init's re-run (decision 256d1059): init shares syncAgents,
// so a config.models bump the installed agent does not carry is reported as a
// differs row naming both values and the fix — never a crash on an unmapped
// status, never a rewrite.
test('config_drift on re-init: a config.models bump is reported differs with both values and the fix; the agent is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const tuned = JSON.parse(readFileSync(configPath, 'utf8'));
    tuned.models.librarian = { model: 'claude-drift-probe-9', effort: 'high' };
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));
    const agentPath = join(dir, '.claude', 'agents', 'librarian.md');
    const agentBefore = readFileSync(agentPath, 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(
      rerun.stdout,
      /^\.claude\/agents\/librarian\.md\s+differs\s+model\/effort drift — installed model=claude-sonnet-5-5 effort=low, config\.models resolves model=claude-drift-probe-9 effort=high; not rewritten — realize it with node "<Sterling root>\/bin\/install-agents\.mjs" \(--target <dir> for a sibling\)/m
    );
    assert.equal(readFileSync(agentPath, 'utf8'), agentBefore, 'config_drift writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('phase-2 wiring: fresh init resolves {{MODEL}}/{{EFFORT}} in the installed agents from its own config.models (no token survives; concrete pinned ids)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);

    // config.models is present and pinned in the config init just wrote.
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.ok(config.models && config.models.librarian, 'init wrote config.models with a librarian entry');

    for (const name of ['librarian.md', 'scout.md']) {
      const installed = readFileSync(join(dir, '.claude', 'agents', name), 'utf8');
      const fm = installed.match(/^---\n([\s\S]*?)\n---/)[1];
      assert.ok(!installed.includes('{{'), `${name}: no substitution token survives install`);
      assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, `${name}: model resolved to a concrete pinned claude- id`);
      assert.match(fm, /^effort: [a-z]+$/m, `${name}: effort resolved to a concrete value`);
    }

    // librarian resolves to the shipped-default librarian model — config.models is
    // the authoritative source at install (matches config.test.ts's shipped default).
    const librarianFm = readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(librarianFm, /^model: claude-sonnet-5-5$/m, 'librarian installs on the shipped-default librarian model (config.models authoritative)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// =============================================================================
// Part C — CODEX MCP AT USER SCOPE, AND NOTHING WRITTEN INTO THE PLUGIN DIRECTORY
// (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// slice S2 and ruling point 2; finding codex-mcp-bridge-needs-codex-0-153-4-pinned-
// side-install). This Part replaces the former "sparring-partner" cases that pinned
// init GENERATING .claude-plugin/sterling-mcp.json (a per-machine file with absolute
// paths and a probed codex entry, refreshed in place): that file is now one COMMITTED,
// machine-independent file, and the codex server lives in the user-level Claude config.
// Init only CHECKS for it and prints one loud line naming the exact remedy.
//
// Seams: CLAUDE_CONFIG_DIR (Claude Code's own variable — the directory holding the
// user-level .claude.json; the helper defaults it to an empty scratch dir so a run never
// reads the developer's real config) and STERLING_CODEX_PROBE (which remedy line).
// =============================================================================

const ADD_COMMAND = 'claude mcp add --scope user codex -- codex mcp-server';
const codexLine = (r) => (r.stdout + r.stderr).match(/^codex mcp: .+/m)?.[0];
const codexRow = (r) => statusLineFor(r.stdout, 'codex MCP (user scope)');
const userConfigDir = (body) => {
  const d = mkdtempSync(join(tmpdir(), 'sterling-userscope-'));
  scratchPluginRoots.add(d);
  if (body !== undefined) writeFileSync(join(d, '.claude.json'), body);
  return d;
};

test('codex user scope case 1: no codex server in the user-level config + a working `codex mcp-server` ⇒ one loud line carrying the exact `claude mcp add --scope user` command; init completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_CODEX_PROBE: 'ok', CLAUDE_CONFIG_DIR: userConfigDir(JSON.stringify({ mcpServers: { other: { command: 'x' } } })) });
    assert.equal(r.code, 0, r.stderr);
    const line = codexLine(r);
    assert.ok(line, 'a codex line is printed');
    assert.ok(line.includes(ADD_COMMAND), `the line carries the exact add command — got: ${line}`);
    assert.match(codexRow(r) ?? '', /\bskipped\b/, 'the report row says skipped, never created/matches');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init still completes its other artifacts');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('codex user scope case 2: probe failures keep their distinguishable skip reasons (binary absent vs not logged in)', () => {
  const dirAbsent = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  const dirLogin = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const rAbsent = init(dirAbsent, FRESH_FLAGS, { STERLING_CODEX_PROBE: 'absent' });
    const rLogin = init(dirLogin, FRESH_FLAGS, { STERLING_CODEX_PROBE: 'not-logged-in' });
    assert.equal(rAbsent.code, 0, rAbsent.stderr);
    assert.equal(rLogin.code, 0, rLogin.stderr);
    const lineAbsent = codexLine(rAbsent);
    const lineLogin = codexLine(rLogin);
    assert.match(lineAbsent ?? '', /^codex mcp: skipped — .{10,}/, 'binary-absent reports an actionable skip line');
    assert.match(lineLogin ?? '', /^codex mcp: skipped — .{10,}/, 'not-logged-in reports an actionable skip line');
    assert.notEqual(lineAbsent, lineLogin, 'the two failure reasons produce distinguishable lines');
    assert.ok(!lineAbsent.includes(ADD_COMMAND), 'no add command is offered when `codex mcp-server` cannot work (it would register a dead server)');
  } finally {
    rmSync(dirAbsent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dirLogin, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('codex user scope case 3: a codex server already registered at user scope ⇒ row matches, NO codex line, and no probe ran', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    // CONTROL: the probe is forced to a failing outcome, so a probe that ran would print a
    // skip line. Its absence below proves the registered case never probes.
    const r = init(dir, FRESH_FLAGS, { STERLING_CODEX_PROBE: 'absent', CLAUDE_CONFIG_DIR: userConfigDir(JSON.stringify({ mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } })) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(codexRow(r) ?? '', /\bmatches\b/, 'the registered server is reported as matching');
    assert.equal(codexLine(r), undefined, 'no codex line: nothing is missing, and the probe did not run');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('codex user scope case 4: an unparseable user-level config is reported as unreadable, never read as "registered"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_CODEX_PROBE: 'ok', CLAUDE_CONFIG_DIR: userConfigDir('{ not json') });
    assert.equal(r.code, 0, r.stderr);
    assert.match(codexLine(r) ?? '', /could not be read/, 'the line says the config could not be read');
    assert.match(codexRow(r) ?? '', /\bskipped\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 5: an unrecognized STERLING_CODEX_PROBE value fails init loud, never silently proceeding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'garbage' });
    assert.notEqual(r.code, 0, 'an unrecognized probe override value must fail init (nonzero exit), never proceed as if unset');
    assert.ok((r.stderr ?? '').length > 0, 'the loud failure is accompanied by a diagnostic on stderr, not a silent nonzero');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('init writes NOTHING into the plugin directory: a consuming init leaves the plugin root empty, and a clone-target init creates no sterling-mcp.json and ignores only the retired win config', () => {
  const plainDir = mkdtempSync(join(tmpdir(), 'sterling-nowrite-plain-'));
  const cloneDir = mkdtempSync(join(tmpdir(), 'sterling-nowrite-clone-'));
  const pluginRootDir = scratchPluginRoot();
  try {
    const r = init(plainDir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: pluginRootDir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(pluginRootDir), [], 'the plugin root is byte-for-byte as empty as it started — init no longer reaches outside --target');
    assert.doesNotMatch(r.stdout, /^\.claude-plugin\/sterling-mcp\.json\b/m, 'no report row for a file init no longer manages');
    assert.doesNotMatch(r.stdout, /per-clone machine truth|write OUTSIDE/i, 'and no side-effect disclosure: there is no side effect');

    const c = init(cloneDir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: cloneDir });
    assert.equal(c.code, 0, c.stderr);
    assert.ok(!existsSync(join(cloneDir, '.claude-plugin')), 'a clone-target init creates no .claude-plugin directory');
    const ignore = readFileSync(join(cloneDir, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(!ignore.includes('.claude-plugin/sterling-mcp.json'), 'the plugin MCP config is COMMITTED: init never adds it to .gitignore');
    assert.ok(ignore.includes('.claude-plugin/sterling-mcp-win.json'), 'CONTROL: the clone-target branch ran — the retired win config is still ignored');
  } finally {
    for (const d of [plainDir, cloneDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// The pin above watches pluginRootMatch, a scratch dir init uses ONLY for branch
// selection; a regressed write through join(pluginRoot, ...) would land on the REAL
// clone and pass it. This one watches the path init actually writes through: every fs
// write of the spawned init and its node children is witnessed (fs-write-witness.mjs
// via NODE_OPTIONS), and none may resolve under the real plugin root, `root` here.
test('init writes NOTHING under its REAL plugin root: every fs write of the spawned init and its node children is witnessed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nowrite-witness-'));
  const target = join(dir, 'project');
  mkdirSync(target);
  const log = join(dir, 'witness.log');
  try {
    writeFileSync(log, '');
    const witness = pathToFileURL(join(root, 'scripts', 'tests', 'lib', 'fs-write-witness.mjs')).href;
    const r = init(target, FRESH_FLAGS, { NODE_OPTIONS: `--import=${witness}`, STERLING_FS_WITNESS_LOG: log });
    assert.equal(r.code, 0, r.stderr);
    const writes = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.ok(writes.some((p) => p === join(target, 'CLAUDE.md')), `CONTROL (non-vacuity): the witness saw init write the target's CLAUDE.md — ${writes.length} write(s) recorded`);
    const underRoot = writes.filter((p) => p === root || p.startsWith(root + sep));
    assert.deepEqual(underRoot, [], 'no write resolves under the real plugin root');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('init records the plugin version in .sterling/synced-version, so the first session after init does not re-sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-synced-version-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    const version = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    const marker = join(dir, '.sterling', 'synced-version');
    assert.ok(existsSync(marker), 'init wrote the marker H1 keys its post-update sync on');
    assert.equal(readFileSync(marker, 'utf8').trim(), version, 'it carries the version whose agents init just installed');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('committed plugin MCP config: one machine-independent `sterling` entry through ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PROJECT_DIR}, referenced by plugin.json, and NOT gitignored', () => {
  const cfgPath = join(root, '.claude-plugin', 'sterling-mcp.json');
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), {
    mcpServers: {
      sterling: {
        command: 'node',
        args: [
          '--disable-warning=ExperimentalWarning',
          '${CLAUDE_PLUGIN_ROOT}/mcp/sterling-mcp.mjs',
          '--project',
          '${CLAUDE_PROJECT_DIR}',
        ],
      },
    },
  });
  assert.equal(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).mcpServers, './.claude-plugin/sterling-mcp.json', 'plugin.json still references it');
  assert.ok(!/\/(home|mnt)\//.test(readFileSync(cfgPath, 'utf8')), 'no absolute machine path');
  const ignored = spawnSync('git', ['check-ignore', '-q', '.claude-plugin/sterling-mcp.json'], { cwd: root });
  assert.equal(ignored.status, 1, 'git does not ignore the file (exit 1 = not ignored)');
});

// Part D (native-Windows codex wiring into sterling-mcp-win.json) was REMOVED
// with the file (decision native-windows-launcher-retired-wsl2-only): every case
// pinned the win config's codex entry, its STERLING_CODEX_PROBE_WIN seam or its
// plugin-repo-only gate, none of which exists any more. The WSL/plugin codex
// wiring stays pinned in Part C above. Init no longer calls the native-Windows
// codex probe on any host.

// =============================================================================
// Part F — WSL2-ONLY INIT (decision native-windows-launcher-retired-wsl2-only).
//
// Sterling runs only under WSL2. The machinery that once chose between a
// Windows-host mode and an opt-in cross-host mode (decision foreign_ffe7c416)
// existed only to decide which Windows artifacts to write, and both of those
// artifacts are retired. What that machinery read — STERLING_NATIVE_MCP_MODE,
// STERLING_DUAL_CONTEXT, the --dual-context flag, STERLING_WIN_NODE and a
// `where.exe node` lookup — is now read by nothing. These pins hold that:
//   • a stray value of any of them is INERT: it neither aborts init nor changes
//     one status row, and no report line names a mode;
//   • init never spawns `where.exe`, whatever is set;
//   • no Windows artifact is written.
// The mode-note pins that preceded this Part (exactly one mode note per run,
// the opt-in switching it, the '1'-not-truthy opt-in value) were deleted with
// the note: their subject no longer exists.
// =============================================================================

// A run's status rows as `item status` pairs — the whole observable outcome of
// an init, minus the per-run detail text (which carries temp paths).
const statusRows = (out) =>
  out.split('\n')
    .map((l) => l.match(/^(\S+)\s+(created|skipped|matches|refreshed|differs|refused|stale|exists|ok|migrated|manual)\b/))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`);
// Any line that reports a run MODE. Matched on the retired mode names.
const NAMES_A_MODE = /\b(host-native|dual-context)\b/i;
const modeLines = (out) => out.split('\n').filter((l) => NAMES_A_MODE.test(l) && !/^\S+\s+(created|skipped|matches|refreshed|differs|refused|stale|exists)\b/.test(l));

test('WSL2-only: an unrecognized STERLING_NATIVE_MCP_MODE no longer aborts init — the value is inert and changes no status row', () => {
  const ctlDir = mkdtempSync(join(tmpdir(), 'sterling-wslonly-ctl-'));
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wslonly-mode-'));
  try {
    // CONTROL, PLACED FIRST: the same fixture with the variable absent. Its
    // status rows are what "changes nothing" is measured against.
    const ctl = init(ctlDir, FRESH_FLAGS, { STERLING_NATIVE_MCP_MODE: undefined });
    assert.equal(ctl.code, 0, ctl.stderr);
    const ctlRows = statusRows(ctl.stdout);
    assert.ok(ctlRows.length > 5, `CONTROL: the baseline run reports its manifest — got ${JSON.stringify(ctlRows)}`);

    const r = init(dir, FRESH_FLAGS, { STERLING_NATIVE_MCP_MODE: 'no-such-mode' });
    assert.equal(r.code, 0, `a stray STERLING_NATIVE_MCP_MODE must not abort init — the subsystem it steered is gone: ${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /STERLING_NATIVE_MCP_MODE/, 'init neither validates nor mentions the retired variable');
    assert.deepEqual(statusRows(r.stdout), ctlRows, 'every status row equals the run without the variable');
    assert.deepEqual(modeLines(r.stdout + r.stderr), [], 'no line reports a run mode');
  } finally {
    for (const d of [ctlDir, dir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: restore the `fail(...)` on an unknown STERLING_NATIVE_MCP_MODE — the
// exit-0 assertion goes red while the control stays green.

test('WSL2-only: init never spawns where.exe and writes no Windows artifact — even with every former opt-in set (--dual-context, STERLING_DUAL_CONTEXT=1, STERLING_NATIVE_MCP_MODE, STERLING_WIN_NODE)', { skip: process.platform === 'win32' ? 'the fake where.exe is a POSIX shell script' : false }, () => {
  const bin = mkdtempSync(join(tmpdir(), 'sterling-wslonly-bin-'));
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wslonly-optin-'));
  const marker = join(bin, 'where-exe-was-spawned');
  try {
    // A where.exe on PATH that records being spawned.
    const fake = join(bin, 'where.exe');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${marker}'\necho 'C:\\\\fake\\\\node.exe'\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };

    // CONTROL, PLACED FIRST: the fake is really what a bare `where.exe` resolves
    // to under this PATH, so an absent marker below means init never spawned it
    // — not that the fake was unreachable.
    spawnSync('where.exe', ['node'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.ok(existsSync(marker), 'CONTROL: the fake where.exe is resolvable and records its spawn');
    rmSync(marker);

    // Plugin-repo branch (seam aimed at the target) so the retired win MCP
    // config's old site is exercised too.
    const r = init(dir, [...FRESH_FLAGS, '--dual-context'], {
      ...env,
      STERLING_PLUGIN_ROOT_MATCH: dir,
      STERLING_DUAL_CONTEXT: '1',
      STERLING_NATIVE_MCP_MODE: 'host-native',
      STERLING_WIN_NODE: undefined,
    });
    assert.equal(r.code, 0, `the former opt-ins are ignored, never refused: ${r.stderr}`);
    const report = r.stdout + r.stderr;
    assert.ok(!existsSync(marker), `init spawned where.exe (args: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''})`);
    assert.ok(!existsSync(join(dir, 'sterling-windows.bat')), 'no native launcher');
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json')), 'no win MCP config');
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp.json')), 'init no longer generates the plugin MCP config (it is committed, slice S2)');
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.claude-plugin\/sterling-mcp-win\.json$/m, 'CONTROL: the plugin-root gate is open — the clone-target branch ran (its plugin-repo-only .gitignore entry is present)');
    // Former inert-opt-in disclosure (Part G F2) is gone with the opt-in itself.
    assert.doesNotMatch(report, /STERLING_WSL_NODE|no effect/i, 'no inert-flag disclosure: there is no flag left to be inert');
    assert.deepEqual(modeLines(report), [], 'no line reports a run mode');
    assert.ok(!/REFUSED/.test(report), 'nothing was refused');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init completed the rest of the manifest');
    assert.ok(existsSync(join(dir, 'claude-code.bat')), 'the WSL launcher is still generated');
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'librarian.md')), 'agents still installed');

    // A flagless re-run in the same environment: still no where.exe, no mode line.
    const rerun = init(dir, [], { ...env, STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_DUAL_CONTEXT: '1', STERLING_WIN_NODE: undefined });
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.ok(!existsSync(marker), 'the re-run never spawns where.exe either');
    assert.deepEqual(modeLines(rerun.stdout + rerun.stderr), [], 'the re-run reports no run mode either');
  } finally {
    for (const d of [bin, dir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: restore the `where.exe node` lookup under the opt-in — the marker
// assertion goes red while the CONTROL stays green.

// =============================================================================
// Part G — the FOUR review-driven fixes that landed on top of decision foreign_ffe7c416
// (slug host-native-init-with-dev-machine-escape-hatch) with NO frozen pin. A
// green suite over them proved only that nothing BROKE; every one of them is a
// behaviour a future edit can silently delete.
//
// SPEC-ONLY, and strictly so: scripts/init-impl.mjs's implementation body was NOT
// read to author this section (the test-writer read wall) — these pins are
// written against the dispatch spec and the ruling. Consequence for how they are
// written: where the spec quoted a report STRING, this file pins a TOKEN inside
// it (a variable name, a filename, a distinctive word) rather than the sentence,
// so a reworded report reds nothing while a deleted BEHAVIOUR still reds. Where
// a claim is about bytes on disk it is asserted on the bytes, never on prose.
//
//   F1  MANAGED REFRESH OF A STALE PLUGIN MCP COMMAND. An existing
//       .claude-plugin/sterling-mcp.json sterling entry whose args[0] equals the
//       generated server entry but whose `command` differs is PROVABLY OURS
//       (nobody else names this clone's dist/main.js), so init repoints it at the
//       running interpreter and reports 'refreshed'. The ownership boundary is
//       args[0], NOT the command. Why it matters: nvm-windows moves execPath on a
//       node upgrade, and before this fix sterling-mcp.json kept naming a deleted
//       node.exe forever while the launcher regenerated happily — native claude
//       got no Sterling MCP at all.
//   F1b (ported to WSL2-only) a 'differs' on that same file is reported and left
//       byte-identical, with no native-claude warn — the warn existed only for a
//       Windows-host mode that is retired.
//   F2  (removed with the retired opt-in — see the note at its old site)
//   F3  (removed with the retired native launcher — see the note at its old site)
//   F4  (removed with the retired Windows artifacts — see the note at its old site)
//
// SEAMS USED: STERLING_PLUGIN_ROOT_MATCH, STERLING_CODEX_PROBE.
// =============================================================================

// Part G carries its OWN status-line regex rather than sharing Part F's helpers,
// so changing what one Part counts as a status line never silently changes what
// another Part's pin counts.
const STATUS_LINE_G = /^\S+\s+(created|skipped|matches|refreshed|differs|refused|stale|exists)\b/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const statusLineFor = (out, path) => (out.match(new RegExp(`^${escapeRe(path)}\\s+.+$`, 'm')) ?? [null])[0];
// F1 / F1b (the managed refresh of a stale plugin MCP command, and the `differs`
// report on a hand-edited entry) were REMOVED with the behaviour they pinned: init no
// longer generates, refreshes or reports .claude-plugin/sterling-mcp.json — the file is
// committed and machine-independent (decision sterling-ships-as-a-marketplace-plugin-
// authoring-machine-keeps-its-clone, slice S2). What replaces them is Part C's
// "init writes NOTHING into the plugin directory" and "committed plugin MCP config".

// F2 (the inert-opt-in disclosure) was REMOVED with the opt-in it disclosed
// (decision native-windows-launcher-retired-wsl2-only). Its surviving CONTROL —
// the former opt-in prints no inert-flag warn and init exits 0 with the rest of
// the manifest — is ported into Part F's "never spawns where.exe" pin, which runs
// with both opt-in forms and the stray mode value set together.

// F3a/F3b (the native launcher's line-2 stamp and its marker-driven re-bake)
// were REMOVED with the launcher itself (decision
// native-windows-launcher-retired-wsl2-only): their only subject was
// sterling-windows.bat, which init no longer renders. The stamp mechanism they
// exercised survives in scripts/lib/generated-marker.mjs for sterling-update.bat:
// F3a's line-1/line-2 placement pin is ported to scripts/tests/update.test.mjs
// ("sterling-update.bat keeps `@echo off` on line 1 …"), and the marker-driven
// refresh / hand-edit-differs behaviour is covered there by the ensureUpdateLauncher
// tests. F3b's native-launcher-specific arms (a re-baked Windows node path) have
// no surviving subject.

// F4a/F4b (the stale-vs-skipped report for the two Windows-node-gated artifacts)
// were REMOVED with those artifacts (decision
// native-windows-launcher-retired-wsl2-only); an existing leftover of either is
// now pinned by the 'retired native launcher' and 'retired win MCP config' tests.

// =============================================================================
// PART H — CONTAINMENT GUARD: RUNNING THIS SUITE IS NOT AN ACT OF DEPLOYMENT
//
// anti_pattern a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree
// (severity BLOCK, knowledge_get 37b3cb0a-2e54-4ce2-99b9-45b68d6e6e0f). Its
// recorded correction has two halves and BOTH are needed: redirect the write to a
// temp dir (the helper defaults at the top of this file), and then PIN that the
// live artifact was untouched — because a redirect that silently regresses looks
// exactly like a passing suite. This is that second half.
//
// DECLARED LAST ON PURPOSE. LIVE_STAMPS_AT_LOAD is captured at module load, before
// the first test runs, and node:test executes top-level synchronous tests in
// declaration order — so the equality below spans EVERY init spawn in this file,
// not merely the two made here. A future case that forgets the seam is caught by
// this pin even though it lives hundreds of lines away.
// =============================================================================

test('H containment: the whole suite leaves THIS clone\'s committed plugin MCP config and the retired win config untouched, and a default-seam init writes nothing into its plugin root', () => {
  const plainDir = mkdtempSync(join(tmpdir(), 'sterling-containment-plain-'));
  try {
    // THE PIN: a representative CONSUMING-TARGET init with no seam set by the caller,
    // the exact shape of the dozens of `init(dir, FRESH_FLAGS)` calls in this file. The
    // helper default aims the plugin root at a fresh scratch directory; init writes
    // nothing into the plugin directory any more (slice S2), so that directory must
    // still be EMPTY afterwards. THE DELIVERED EFFECT, not the helper's intent: had
    // init resumed writing into its plugin root, the artifact would appear here.
    const r = init(plainDir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(r.pluginRootMatch), [], 'a default-seam init wrote into its plugin root — the containment default or init\'s no-write rule regressed');
    assert.ok(!existsSync(join(plainDir, '.claude-plugin', 'sterling-mcp.json')), 'and nothing was relocated into the consuming target either');

    // Documentation of intent (harness-side, NOT the verdict).
    assert.notEqual(fwdPath(r.pluginRootMatch), fwdPath(root), 'INTENT: the plugin-root-match is not this clone');
    assert.notEqual(fwdPath(r.pluginRootMatch), fwdPath(plainDir), 'INTENT: nor the --target — a target-valued default would flip every consuming fixture into a clone-target one');

    // CONTAINMENT ITSELF: mtime+size across the whole run (ABSENT counts as a stamp;
    // bytes would be hollow — an in-place rewrite of a clean tree is byte-identical).
    // The committed sterling-mcp.json is now a tracked source file, so a suite run that
    // touched it would dirty the working tree.
    assert.deepEqual(
      liveStamps(),
      LIVE_STAMPS_AT_LOAD,
      'this clone\'s .claude-plugin/sterling-mcp{,-win}.json must be byte-and-timestamp untouched across the entire suite (anti_pattern 37b3cb0a, severity block)' // not-a-citation: fixture id
    );
  } finally {
    rmSync(plainDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: make init write anything into its plugin root (for example restore the old
// plugin-config ensure) — the readdirSync assertion goes red on every machine, because
// the scratch root is the only place the write can land. liveStamps reddens IN ADDITION
// only when a spawn is aimed at the real clone (the seam dropped from the helper).

// Decision init-prepares-opencode-portable-agents-and-target-handoff-projections:
// init prepares a target for engineers WITHOUT Sterling — portable OpenCode agents
// and the handoff projection, all committed (never gitignored), and a rerun is
// byte-stable.
// CHANGED (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting): the
// tests below pinned those files as WORK-ONLY (decision
// project-mode-hobby-work-toggle-decides-flow, slice S1) and switched the mode to
// get them. They follow config.handoff.enabled now, in either mode. A fresh init
// records it off (the shipped default), so the tests turn it on — as the TUI
// System tab does — and re-run init.
const setConfigKey = (dir, patch) => {
  const p = join(dir, '.sterling', 'config.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...patch }, null, 2));
};
const setMode = (dir, mode) => setConfigKey(dir, { mode });
const setHandoff = (dir, enabled) => setConfigKey(dir, { handoff: { enabled } });
const HANDOFF_OFF_ROW = /^\.opencode\/agents\/ \+ handoff projection\s+skipped\s+handoff files are off \(config\.handoff\.enabled is not true: the portable OpenCode agents and the handoff projection are not written; existing files are no longer maintained, and nothing is deleted\)/m;
const HANDOFF_SET = ['.opencode/agents/implementor.md', '.opencode/agents/researcher.md', '.opencode/agents/scout.md', 'architecture.md', 'rulings.md'];

test('handoff setting: a fresh init records it off and writes no portable agents and no handoff files, with a loud skip row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-init-hobby-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(cfg.mode, 'hobby', 'a fresh config records the hobby default');
    assert.deepEqual(cfg.handoff, { enabled: false }, 'a fresh config records handoff off');
    assert.match(r.stdout, HANDOFF_OFF_ROW);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')));
    assert.ok(!existsSync(join(dir, 'architecture.md')));
    assert.ok(!existsSync(join(dir, 'rulings.md')));
    assert.ok(!existsSync(join(dir, 'docs', 'sterling')));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// The four combinations: the files follow the key, and the recorded mode is
// whatever --mode said, with the key on and off.
for (const mode of ['hobby', 'work']) {
  for (const on of [true, false]) {
    test(`handoff setting (${mode}, handoff ${on ? 'on' : 'off'}): init ${on ? 'writes the portable agents and the handoff projection' : 'writes neither, with the skip row'}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-init-combo-'));
      try {
        assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
        assert.equal(init(dir, [...FRESH_FLAGS, '--mode', mode]).code, 0);
        setHandoff(dir, on);
        const r = init(dir);
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.equal(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode, mode, 'the mode is kept');
        assert.doesNotMatch(r.stdout, /hand-edited|differs.*config\.json/i, 'a toggled handoff setting is a recorded declaration, not a hand edit');
        if (on) {
          assert.doesNotMatch(r.stdout, HANDOFF_OFF_ROW);
          for (const f of HANDOFF_SET) assert.ok(existsSync(join(dir, f)), `${f} written`);
        } else {
          assert.match(r.stdout, HANDOFF_OFF_ROW);
          for (const f of HANDOFF_SET) assert.ok(!existsSync(join(dir, f)), `${f} not written`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  }
}

// CHANGED: this pinned an invalid MODE as the refused handoff row. Init's handoff
// step no longer reads the mode; the refused row belongs to a handoff value that is
// not a boolean, and an invalid mode leaves the handoff step alone.
test('handoff setting: a non-boolean value is a refused row naming the value — the rest of init completes, nothing handoff-related is written; an invalid mode does not refuse the handoff step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-init-invalid-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    setHandoff(dir, 'yes');
    const r = init(dir);
    assert.match(r.stdout, /^\.opencode\/agents\/ \+ handoff projection\s+refused\s+config\.handoff\.enabled is "yes"/m, r.stdout + r.stderr);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')));
    assert.ok(!existsSync(join(dir, 'architecture.md')));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).handoff, { enabled: 'yes' }, 'the raw value is left for the user to fix');
    setHandoff(dir, true);
    setMode(dir, 'Work');
    const m = init(dir);
    assert.doesNotMatch(m.stdout, /handoff projection\s+refused\s+config\.mode/m, m.stdout + m.stderr);
    for (const f of HANDOFF_SET) assert.ok(existsSync(join(dir, f)), `${f} written although the mode is invalid`);
    assert.equal(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode, 'Work', 'the raw mode is left for the user to fix');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('handoff setting: on→off re-init deletes nothing — every file byte-identical, skip row says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-init-tohobby-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    setHandoff(dir, true);
    assert.equal(init(dir).code, 0);
    const before = Object.fromEntries(HANDOFF_SET.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    setHandoff(dir, false);
    const r = init(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, HANDOFF_OFF_ROW);
    for (const [f, content] of Object.entries(before)) assert.equal(readFileSync(join(dir, f), 'utf8'), content, `${f} kept byte-identical`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('handoff setting: a fresh init of a project whose portable agents are already tracked in git records it on and maintains them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-init-tracked-'));
  const git = (args) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  try {
    git(['init', '-q']);
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    setHandoff(dir, true);
    assert.equal(init(dir).code, 0);
    git(['add', '.opencode/agents/scout.md']);
    git(['commit', '-qm', 'portable']);
    // a second machine: the commit is there, the untracked .sterling/ is not
    rmSync(join(dir, '.sterling'), { recursive: true, force: true });
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).handoff, { enabled: true });
    assert.doesNotMatch(r.stdout, HANDOFF_OFF_ROW);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('handoff setting: a fresh init where git cannot say what is tracked leaves the handoff key OUT of the new config and says so; nothing handoff-related is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-init-gitfail-'));
  const git = (args) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  try {
    git(['init', '-q']);
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
    git(['add', '.opencode/agents/scout.md']);
    git(['commit', '-qm', 'portable']);
    writeFileSync(join(dir, '.git', 'index'), 'not an index');
    const r = init(dir, FRESH_FLAGS);
    const cfg = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.ok(!('handoff' in cfg), `no explicit handoff value is recorded from a failed git read: ${JSON.stringify(cfg.handoff)}`);
    assert.match(r.stdout, /^note: config\.handoff\.enabled was left out of the new \.sterling\/config\.json — git could not say whether handoff files are committed \(git ls-files exited 128: /m, r.stdout + r.stderr);
    assert.match(r.stdout, /^\.opencode\/agents\/ \+ handoff projection\s+refused\s+.*git ls-files exited 128/m);
    assert.doesNotMatch(r.stdout, HANDOFF_OFF_ROW);
    assert.equal(readFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'utf8'), 'portable\n');
    assert.ok(!existsSync(join(dir, 'architecture.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('upgrade through the init ensure pass: { mode: work }, no handoff key, portable agents committed — a re-run still maintains them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-init-upgrade-'));
  const git = (args) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  const configPath = join(dir, '.sterling', 'config.json');
  try {
    git(['init', '-q']);
    assert.equal(init(dir, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    setHandoff(dir, true);
    assert.equal(init(dir).code, 0);
    git(['add', '.opencode/agents/implementor.md', '.opencode/agents/researcher.md', '.opencode/agents/scout.md']);
    git(['commit', '-qm', 'portable']);
    // the config from before the setting existed: work mode, no handoff key
    const { handoff, ...before } = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(handoff, { enabled: true });
    writeFileSync(configPath, JSON.stringify(before, null, 2));
    rmSync(join(dir, '.opencode', 'agents', 'researcher.md'));
    rmSync(join(dir, 'architecture.md'));
    for (const args of [[], ['--update-ensure']]) {
      const r = init(dir, args);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, HANDOFF_OFF_ROW, `init ${args.join(' ')}`);
      assert.ok(existsSync(join(dir, '.opencode', 'agents', 'researcher.md')), 'the missing portable agent is rewritten');
      assert.ok(existsSync(join(dir, 'architecture.md')), 'the projection is rewritten');
      assert.ok(!('handoff' in JSON.parse(readFileSync(configPath, 'utf8'))), 'the recorded config is left as it was');
      rmSync(join(dir, '.opencode', 'agents', 'researcher.md'));
      rmSync(join(dir, 'architecture.md'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// /sterling:init asks work-or-hobby on a NEW project (user-stated 2026-09-28: "When a
// new proj ct is sterling inited, it should ask if it is a work or hobby project") and
// passes the answer as --mode. CHANGED: the two tests below pinned that --mode work
// wrote the OpenCode and handoff files on the first init and --mode hobby did not.
// --mode records the shipping flow only; neither mode writes those files.
const MODE_LINE = (text) => new RegExp(`^mode: ${text}`, 'm');

test('--mode work on a new init records work and writes no handoff files: the mode is the shipping flow only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-work-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    const r = init(dir, [...FRESH_FLAGS, '--mode', 'work']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const cfg = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(cfg.mode, 'work');
    assert.deepEqual(cfg.handoff, { enabled: false }, 'work mode does not turn the handoff files on');
    assert.match(r.stdout, MODE_LINE('work \\(set by --mode\\)'));
    assert.match(r.stdout, HANDOFF_OFF_ROW);
    for (const f of HANDOFF_SET) assert.ok(!existsSync(join(dir, f)), `${f} not written`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('--mode hobby on a new init records hobby, says it was set, and writes no handoff files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-hobby-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    const r = init(dir, [...FRESH_FLAGS, '--mode', 'hobby']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode, 'hobby');
    assert.match(r.stdout, MODE_LINE('hobby \\(set by --mode\\)'));
    assert.match(r.stdout, HANDOFF_OFF_ROW);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')));
    assert.ok(!existsSync(join(dir, 'architecture.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a new init with no --mode records hobby explicitly and prints the defaulted line naming the TUI System tab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-default-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode, 'hobby');
    assert.match(r.stdout, MODE_LINE('hobby \\(defaulted — no --mode was given; change it in the TUI System tab\\)'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an invalid --mode refuses with exit 2 naming the valid set, before anything is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-invalid-'));
  try {
    for (const bad of ['Work', 'banana', '']) {
      const r = init(dir, [...FRESH_FLAGS, `--mode=${bad}`]);
      assert.equal(r.code, 2, `--mode=${bad}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout + r.stderr, /--mode must be 'hobby' or 'work'/);
      assert.ok(!existsSync(join(dir, '.sterling')), `--mode=${bad}: nothing written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an existing config\'s mode is never overwritten by --mode: kept, with a loud notice when the flag differs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-kept-'));
  try {
    assert.equal(init(dir, [...FRESH_FLAGS, '--mode', 'hobby']).code, 0);
    const configBefore = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
    const differs = init(dir, ['--mode', 'work']);
    assert.equal(differs.code, 0, differs.stdout + differs.stderr);
    assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), configBefore, 'config byte-identical');
    assert.match(differs.stdout, MODE_LINE('hobby \\(kept — the recorded config wins\\)'));
    assert.match(differs.stdout, /^⚠ --mode work NOT applied: this project's recorded mode is hobby — switch it in the TUI System tab, then rerun init or \/sterling:update$/m);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')), 'the recorded hobby mode still decides');

    const same = init(dir, ['--mode', 'hobby']);
    assert.equal(same.code, 0, same.stdout + same.stderr);
    assert.match(same.stdout, MODE_LINE('hobby \\(kept — the recorded config wins\\)'));
    assert.doesNotMatch(same.stdout, /NOT applied: this project's recorded mode/);

    const flagless = init(dir);
    assert.equal(flagless.code, 0, flagless.stdout + flagless.stderr);
    assert.match(flagless.stdout, MODE_LINE('hobby \\(kept — the recorded config wins\\)'));
    assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), configBefore, 'config still byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// A new project initialised from a session in another Sterling project takes that
// invoking project's mode without asking (board a-project-initialised-from-another-
// project-inherits-that-pro). The invoking project is EXPLICIT: only
// --invoking-project names it. Nothing ambient (CLAUDE_PROJECT_DIR, the shell cwd) is
// read, because neither says reliably which project the session belongs to.
const INHERIT_LINE = (mode, from) => new RegExp(`^mode: ${mode} \\(inherited from the invoking project ${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm');
const withTwoDirs = (fn) => {
  const invoking = mkdtempSync(join(tmpdir(), 'sterling-mode-inherit-from-'));
  const fresh = mkdtempSync(join(tmpdir(), 'sterling-mode-inherit-new-'));
  try {
    fn(invoking, fresh);
  } finally {
    rmSync(invoking, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};
const modeOf = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode;
const INVOKING = '--invoking-project';

for (const mode of ['work', 'hobby']) {
  test(`--invoking-project: a new project initialised from a ${mode} project inherits ${mode}, with one line naming the source`, () => {
    withTwoDirs((invoking, fresh) => {
      assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', mode]).code, 0);
      const r = init(fresh, [...FRESH_FLAGS, INVOKING, invoking]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(modeOf(fresh), mode);
      assert.match(r.stdout, INHERIT_LINE(mode, invoking));
      assert.equal(r.stdout.split('\n').filter((l) => /^mode: /.test(l)).length, 1, 'exactly one mode line');
      assert.doesNotMatch(r.stdout, /defaulted/);
    });
  });
}

test('--invoking-project: an invoking project with no mode key is hobby, as everywhere else', () => {
  withTwoDirs((invoking, fresh) => {
    assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    const p = join(invoking, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    delete cfg.mode;
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    const r = init(fresh, [...FRESH_FLAGS, INVOKING, invoking]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(modeOf(fresh), 'hobby');
    assert.match(r.stdout, INHERIT_LINE('hobby', invoking));
  });
});

test('--invoking-project: an explicit --mode wins and the invoking config is not read', () => {
  withTwoDirs((invoking, fresh) => {
    assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    const r = init(fresh, [...FRESH_FLAGS, '--mode', 'hobby', INVOKING, invoking]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(modeOf(fresh), 'hobby');
    assert.match(r.stdout, MODE_LINE('hobby \\(set by --mode\\)'));
    assert.doesNotMatch(r.stdout, /inherited/);
    // not read: an invalid invoking mode does not stop an explicit --mode
    const p = join(invoking, '.sterling', 'config.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), mode: 'Work' }, null, 2));
    const other = mkdtempSync(join(tmpdir(), 'sterling-mode-inherit-explicit-'));
    try {
      const r2 = init(other, [...FRESH_FLAGS, '--mode', 'work', INVOKING, invoking]);
      assert.equal(r2.code, 0, r2.stdout + r2.stderr);
      assert.equal(modeOf(other), 'work');
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

test('--invoking-project on an existing project never changes its mode', () => {
  withTwoDirs((invoking, existing) => {
    assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    assert.equal(init(existing, [...FRESH_FLAGS, '--mode', 'hobby']).code, 0);
    const before = readFileSync(join(existing, '.sterling', 'config.json'), 'utf8');
    const r = init(existing, [INVOKING, invoking]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(existing, '.sterling', 'config.json'), 'utf8'), before, 'config byte-identical');
    assert.match(r.stdout, MODE_LINE('hobby \\(kept — the recorded config wins\\)'));
    assert.doesNotMatch(r.stdout, /inherited/);
  });
});

test('--invoking-project equal to the target behaves as no flag: hobby with the defaulted line', () => {
  withTwoDirs((_invoking, fresh) => {
    const r = init(fresh, [...FRESH_FLAGS, INVOKING, fresh]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(modeOf(fresh), 'hobby');
    assert.match(r.stdout, MODE_LINE('hobby \\(defaulted — no --mode was given; change it in the TUI System tab\\)'));
    assert.doesNotMatch(r.stdout, /inherited/);
  });
});

test('--invoking-project naming a directory that is not a Sterling project refuses with exit 2 and writes nothing', () => {
  withTwoDirs((bare, fresh) => {
    for (const named of [bare, join(bare, 'no-such-dir')]) {
      const r = init(fresh, [...FRESH_FLAGS, INVOKING, named]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      const out = r.stdout + r.stderr;
      assert.match(out, /--invoking-project names a directory that is not a Sterling project/);
      assert.ok(out.includes(named.replace(/\\/g, '/')), out);
      assert.ok(!existsSync(join(fresh, '.sterling')), 'nothing written');
    }
  });
});

test('--invoking-project with no value, or followed by another flag, refuses with exit 2 and writes nothing', () => {
  withTwoDirs((invoking, fresh) => {
    for (const bad of [[INVOKING], [`${INVOKING}=`], [INVOKING, '--backup-opt-out']]) {
      const r = init(fresh, [...FRESH_FLAGS, ...bad]);
      assert.equal(r.code, 2, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--invoking-project/);
      assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
      assert.ok(!existsSync(join(fresh, '.sterling')), `${bad.join(' ')}: nothing written`);
    }
  });
});

test('--invoking-project whose project has an invalid mode refuses with exit 2 naming the file and the value, and writes nothing', () => {
  withTwoDirs((invoking, fresh) => {
    assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    const p = join(invoking, '.sterling', 'config.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), mode: 'Work' }, null, 2));
    const r = init(fresh, [...FRESH_FLAGS, INVOKING, invoking]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    const out = r.stdout + r.stderr;
    assert.match(out, /init REFUSED/);
    assert.ok(out.includes(`${invoking.replace(/\\/g, '/')}/.sterling/config.json`), out);
    assert.ok(out.includes('"Work"'), out);
    assert.ok(!existsSync(join(fresh, '.sterling')), 'nothing written');
  });
});

test('--invoking-project whose .sterling is a symlink leaving the project refuses with exit 2, not a stack trace', () => {
  withTwoDirs((invoking, fresh) => {
    const outside = mkdtempSync(join(tmpdir(), 'sterling-mode-inherit-outside-'));
    try {
      writeFileSync(join(outside, 'config.json'), JSON.stringify({ mode: 'work' }));
      symlinkSync(outside, join(invoking, '.sterling'), 'dir');
      const r = init(fresh, [...FRESH_FLAGS, INVOKING, invoking]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /init REFUSED/);
      assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
      assert.ok(!existsSync(join(fresh, '.sterling')), 'nothing written');
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

test('without --invoking-project nothing ambient is read: a cwd inside a work project and CLAUDE_PROJECT_DIR naming it still default to hobby', () => {
  withTwoDirs((invoking, fresh) => {
    assert.equal(init(invoking, [...FRESH_FLAGS, '--mode', 'work']).code, 0);
    const r = init(fresh, FRESH_FLAGS, { CLAUDE_PROJECT_DIR: invoking }, { cwd: invoking });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(modeOf(fresh), 'hobby');
    assert.match(r.stdout, MODE_LINE('hobby \\(defaulted — no --mode was given; change it in the TUI System tab\\)'));
    assert.doesNotMatch(r.stdout, /inherited/);
  });
});

test('a malformed --mode (given twice, or followed by another flag) refuses with exit 2, never a stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-malformed-'));
  try {
    for (const bad of [['--mode', 'work', '--mode=work'], ['--mode', '--backup-opt-out']]) {
      const r = init(dir, [...FRESH_FLAGS, ...bad]);
      assert.equal(r.code, 2, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--mode/);
      assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
      assert.ok(!existsSync(join(dir, '.sterling')), `${bad.join(' ')}: nothing written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an existing config with NO mode key is never given one by --mode: bytes identical, key still absent, notice printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-flag-absent-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const p = join(dir, '.sterling', 'config.json');
    const { mode: _dropped, ...withoutMode } = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, JSON.stringify(withoutMode, null, 2));
    const configBefore = readFileSync(p, 'utf8');
    const r = init(dir, ['--mode', 'work']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(p, 'utf8'), configBefore, 'config byte-identical');
    assert.ok(!('mode' in JSON.parse(readFileSync(p, 'utf8'))), 'mode still absent');
    assert.match(r.stdout, MODE_LINE('hobby \\(kept — the recorded config wins\\)'));
    assert.match(r.stdout, /^⚠ --mode work NOT applied: this project's recorded mode is hobby — switch it in the TUI System tab, then rerun init or \/sterling:update$/m);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('OpenCode handoff: with handoff on, init writes committed .opencode/agents/ and the handoff projection; a rerun matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-opencode-init-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    // handoff off→on: the next init provisions (HEAD unchanged — init always provisions a target that has it on)
    setHandoff(dir, true);
    const r = init(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, HANDOFF_OFF_ROW);
    for (const name of ['implementor', 'researcher', 'scout']) {
      assert.match(r.stdout, new RegExp(`^\\.opencode/agents/${name}\\.md\\s+created\\b`, 'm'));
      assert.match(readFileSync(join(dir, '.opencode', 'agents', `${name}.md`), 'utf8'), /^---\ndescription: .+\nmode: subagent\n/);
    }
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'librarian.md')), 'librarian is not portable');
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'conductor.md')), 'conductor is not portable');
    assert.match(r.stdout, /^architecture\.md \+ rulings\.md \+ docs\/sterling\/ \(handoff projection\)\s+refreshed\s+written/m);
    assert.match(readFileSync(join(dir, 'architecture.md'), 'utf8'), /No records yet/);
    assert.match(readFileSync(join(dir, 'rulings.md'), 'utf8'), /No records yet/);
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(config.generated_projections, ['architecture.md', 'rulings.md']);

    for (const path of ['.opencode/agents/scout.md', 'architecture.md', 'rulings.md']) {
      const ignored = spawnSync('git', ['check-ignore', '-q', path], { cwd: dir, encoding: 'utf8' });
      assert.equal(ignored.status, 1, `${path} must NOT be gitignored (it is committed for engineers without Sterling)`);
    }

    const tracked = ['.opencode/agents/scout.md', 'architecture.md', 'rulings.md', '.sterling/config.json'];
    const before = Object.fromEntries(tracked.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+matches\b/m, 'the managed generated_projections entries do not read as a hand edit');
    assert.match(rerun.stdout, /^\.opencode\/agents\/scout\.md\s+matches\b/m);
    assert.match(rerun.stdout, /^architecture\.md \+ rulings\.md \+ docs\/sterling\/ \(handoff projection\)\s+matches\s+unchanged/m);
    for (const [f, content] of Object.entries(before)) assert.equal(readFileSync(join(dir, f), 'utf8'), content, `${f} byte-identical on rerun`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Sol review MEDIUM: the destructive-conflict preflight runs before ANY write, so
// a regular file where a handoff directory must be is refused before init creates
// anything.
for (const rel of ['.opencode', '.opencode/agents', 'docs/sterling', 'docs/sterling/articles', 'docs/sterling/decisions', 'docs/sterling/anti-patterns']) {
  test(`preflight: a regular file at ${rel} is refused before anything is written`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-preflight-'));
    try {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), 'a file, not a directory\n');
      const r = init(dir, FRESH_FLAGS);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`init REFUSED \\(destructive\\): '${rel.replace(/\./g, '\\.')}' exists as a file`));
      assert.ok(!existsSync(join(dir, '.sterling')), 'nothing was written');
      assert.equal(readFileSync(join(dir, rel), 'utf8'), 'a file, not a directory\n');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

// Sol review MEDIUM: a target that ALREADY ignores the handoff paths would never
// commit them. Init refuses those rows loudly, naming the rule, and leaves the
// user's ignore rules alone.
test('OpenCode handoff: a target whose .gitignore already covers the handoff paths gets refused rows naming the rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-opencode-ignored-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, '.gitignore'), '.opencode/\nrulings.md\n');
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    setHandoff(dir, true); // the handoff files follow config.handoff.enabled
    const r = init(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\.opencode\/agents\/scout\.md\s+refused\s+ignored by git/m);
    assert.match(r.stdout, /\.gitignore:1:\.opencode\//);
    assert.match(r.stdout, /^architecture\.md \+ rulings\.md \+ docs\/sterling\/ \(handoff projection\)\s+refused\s+REFUSED — .*ignored by git.*\.gitignore:2:rulings\.md/m);
    assert.ok(!existsSync(join(dir, '.opencode', 'agents', 'scout.md')));
    assert.ok(!existsSync(join(dir, 'architecture.md')), 'the projection wrote nothing');
    assert.ok(readFileSync(join(dir, '.gitignore'), 'utf8').startsWith('.opencode/\nrulings.md\n'), 'the user rules are left as they were');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
