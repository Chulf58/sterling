// /sterling:init [S] (spec §12, FULL PRECISION except store internals).
// The conductor runs the mini-grill (stack tags, toolchains, backup path —
// ask, don't guess); this script is the deterministic manifest executor.
// Refusals happen BEFORE any write.
//
//   node scripts/init.mjs --target <dir> --project-name <name>
//     --stack-tags a,b --toolchain <adapter>:<glob>[,<glob>...]
//     (--backup-path <p> | --backup-opt-out) [--domains d1,d2]
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '@sterling/schemas';
import { arg, argAll, fail } from './lib/project.mjs';
import { resolveToolchains } from './adapters/resolve.mjs';
import { installAgents, findDeadTerms } from './lib/agent-distribution.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(arg('--target') ?? process.cwd());
const projectName = arg('--project-name') ?? 'project';
const stackTags = (arg('--stack-tags') ?? '').split(',').filter(Boolean);
const domains = (arg('--domains') ?? '').split(',').filter(Boolean);
const backupPath = arg('--backup-path');
const backupOptOut = process.argv.includes('--backup-opt-out');
const declaredToolchains = argAll('--toolchain').map((spec) => {
  const [adapter, globs] = spec.split(':');
  return { adapter, path_globs: (globs ?? '').split(',').filter(Boolean) };
});

// ---- refusals first: nothing is written until everything validates ----
if (!existsSync(target)) fail(`init REFUSED: target '${target}' does not exist`, 2);
if (existsSync(join(target, '.sterling'))) fail(`init REFUSED: '${target}' is already initialized (.sterling exists)`, 2);
if (existsSync(join(target, 'CLAUDE.md'))) {
  fail(`init REFUSED: '${target}' already has a CLAUDE.md — merge the conductor contract manually, never clobber`, 2);
}
if (!backupPath && !backupOptOut) {
  fail('init REFUSED: a backup path is required, or an EXPLICIT opt-out (--backup-opt-out) — the knowledge base must not live in exactly one gitignored file (§2.3)', 2);
}
if (!declaredToolchains.length) fail('init REFUSED: at least one --toolchain <adapter>:<globs> declaration is required (§9.1)', 2);
if (!stackTags.length) fail('init REFUSED: --stack-tags is required (ask, don’t guess — §12 mini-grill)', 2);
const mcpServerEntry = join(pluginRoot, 'packages', 'mcp-server', 'dist', 'main.js');
if (!existsSync(mcpServerEntry)) fail('init REFUSED: MCP server not built — run `npm run build` in the plugin first', 2);

const baked = await resolveToolchains(declaredToolchains); // throws loudly on unregistered adapters

// ---- §12 manifest, in order ----
const report = [];
const fwd = (p) => p.replace(/\\/g, '/');

// .sterling/ + runs/ + docs/briefs/
mkdirSync(join(target, '.sterling', 'runs'), { recursive: true });
mkdirSync(join(target, 'docs', 'briefs'), { recursive: true });
report.push('created: .sterling/ (+runs/), docs/briefs/');

// default config + declarations baked
const config = parseConfig({
  ...JSON.parse(readFileSync(join(pluginRoot, 'templates', 'default-config.json'), 'utf8')),
  toolchains: baked,
  stack_tags: stackTags,
  domains,
  // stored ABSOLUTE: disposal must hit the same place regardless of caller cwd
  ...(backupPath ? { backup_path: fwd(resolve(target, backupPath)) } : { backup_opt_out: true }),
});
writeFileSync(join(target, '.sterling', 'config.json'), JSON.stringify(config, null, 2));
report.push(`config: ${baked.map((t) => t.adapter).join(', ')} toolchain(s), stack tags [${stackTags.join(', ')}], backup ${backupPath ? fwd(backupPath) : 'OPTED OUT (recorded; snapshots will skip loudly)'}`);
for (const tc of baked) {
  for (const [cap, present] of Object.entries(tc.capabilities ?? {})) {
    if (!present) report.push(`warn: ${tc.adapter}: no ${cap} capability — ${cap} checks will skip loudly (§9.1)`);
  }
}

// store (substrate per the Slice 2 selection; DDL on first open)
const { SterlingStore } = await import('@sterling/store');
new SterlingStore(join(target, '.sterling', 'sterling.db')).close();
report.push('store: .sterling/sterling.db (WAL, FTS5)');

// CLAUDE.md from the shipped template — specified content, never improvised
const claudeMd = readFileSync(join(pluginRoot, 'templates', 'target-claude-md.md'), 'utf8')
  .replaceAll('{{PROJECT_NAME}}', projectName)
  .replaceAll('{{STACK_TAGS}}', stackTags.join(', '))
  .replaceAll('{{TOOLCHAINS}}', baked.map((t) => `${t.adapter} (${t.path_globs.join(', ')})`).join('; '))
  .replaceAll('{{DOMAINS}}', domains.length ? domains.join(', ') : '(none mounted yet — created lazily on first need)')
  .replaceAll('{{BACKUP_PATH}}', backupPath ? fwd(backupPath) : '(opted out — recorded)')
  .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
writeFileSync(join(target, 'CLAUDE.md'), claudeMd);
report.push('CLAUDE.md: generated from templates/target-claude-md.md');

// split launcher from the template, machine-detected paths, gitignored (§11)
const where = (exe) => {
  const r = spawnSync('where', [exe], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : undefined;
};
const claudePath = process.env.CLAUDE_CODE_EXECPATH ?? where('claude') ?? join(process.env.USERPROFILE ?? '~', '.local', 'bin', 'claude.exe');
const wtPath = where('wt') ?? join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
const launcher = readFileSync(join(pluginRoot, 'templates', 'launcher-win.bat'), 'utf8')
  .replaceAll('{{WT}}', `"${wtPath}"`)
  .replaceAll('{{CLAUDE}}', `"${claudePath}" --plugin-dir "${fwd(pluginRoot)}"`)
  .replaceAll('{{NODE}}', `"${process.execPath}"`)
  .replaceAll('{{TUI_BUNDLE}}', join(pluginRoot, 'packages', 'tui', 'bundle', 'sterling-tui.mjs'))
  .replaceAll('{{SPLIT_RATIO}}', String(config.tui_split_ratio));
writeFileSync(join(target, 'sterling.bat'), launcher);
report.push(`launcher: sterling.bat (claude: ${claudePath})`);

// agent installation with version/hash headers (§2.2) + restart gate
const vars = { NODE: `"${fwd(process.execPath)}"`, HOOKS_DIR: fwd(join(pluginRoot, 'hooks')) };
const { report: agentReport, restartInstruction } = installAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(target, '.claude', 'agents'),
  pluginVersion: JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version,
  now: new Date().toISOString(),
  vars,
});
report.push(`agents: ${agentReport.length} installed into .claude/agents/`);

// .mcp.json wiring
writeFileSync(
  join(target, '.mcp.json'),
  JSON.stringify(
    { mcpServers: { sterling: { command: process.execPath, args: [fwd(mcpServerEntry), '--store', fwd(join(target, '.sterling', 'sterling.db'))] } } },
    null,
    2
  )
);
report.push('.mcp.json: sterling MCP server wired');

// hook registrations: the project-level §6 set ships in the PLUGIN's
// hooks.json and activates with the plugin — init does not duplicate it.
report.push('hooks: project-level set active via the plugin (hooks/hooks.json) — not duplicated');

// gitignore entries (§2.3/§11/§12): store, launcher, per-machine agents, in-repo backup path
const gitignorePath = join(target, '.gitignore');
const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
const entries = ['.sterling/', 'sterling.bat', '.claude/agents/'];
if (backupPath) {
  const abs = fwd(resolve(target, backupPath));
  const root = fwd(target);
  if (abs === root || abs.startsWith(root + '/')) entries.push(abs === root ? '/' : abs.slice(root.length + 1) + '/');
}
const missing = entries.filter((e) => !existing.split(/\r?\n/).includes(e));
if (missing.length) appendFileSync(gitignorePath, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
report.push(`gitignore: ${missing.join(', ') || '(all present)'}`);

// dead-term check over the scaffolded content (§12)
for (const [label, content] of [['CLAUDE.md', claudeMd], ['sterling.bat', launcher]]) {
  const hits = findDeadTerms(content);
  if (hits.length) fail(`init dead-term check FAILED in generated ${label}: ${hits.map((h) => h.match).join(', ')}`, 1);
}
report.push('dead-term check: clean');

for (const line of report) console.log(line);
console.log('\n' + restartInstruction);
