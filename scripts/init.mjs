// /sterling:init [S] (spec §12, FULL PRECISION except store internals).
// The conductor runs the mini-grill (stack tags, toolchains, backup path —
// ask, don't guess); this script is the deterministic manifest executor.
//
// ENSURE-MANIFEST SEMANTICS (§12, adjudicated): init is an ensure operation,
// not a one-shot. Every manifest item is verified individually:
//   absent            → created
//   matches expected  → skipped, reported as `matches`
//   differs           → left untouched, reported (`differs`) — init never
//                       overwrites content it cannot prove it generated
// Refusal is reserved for destructive actions only (a file occupying a path
// the manifest requires as a directory; an unparseable config it would have
// to clobber). "Already initialized" is NOT a refusal. Every artifact is
// individually regenerable: delete it and re-run — declarations are read
// back from the recorded config, so re-runs need no flags.
//
//   node scripts/init.mjs --target <dir> [--project-name <name>]
//     [--stack-tags a,b] [--toolchain <adapter>:<glob>[,<glob>...]]
//     [--backup-path <p> | --backup-opt-out]
//   (stack tags ARE the domain mount manifest — §3.3; no separate domains flag)
//   (declaration flags are required only when no recorded config exists)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@sterling/schemas';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { arg, argAll, fail } from './lib/project.mjs';
import { backupPathForRuntime } from './lib/wsl-path.mjs';
import { resolveToolchains } from './adapters/resolve.mjs';
import { syncAgents, findDeadTerms, RESTART_INSTRUCTION } from './lib/agent-distribution.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(arg('--target') ?? process.cwd());
const projectNameFlag = arg('--project-name');
const stackTagsFlag = (arg('--stack-tags') ?? '').split(',').filter(Boolean);
const backupPathFlag = arg('--backup-path');
const backupOptOutFlag = process.argv.includes('--backup-opt-out');
const declaredToolchains = argAll('--toolchain').map((spec) => {
  const [adapter, globs] = spec.split(':');
  return { adapter, path_globs: (globs ?? '').split(',').filter(Boolean) };
});

const fwd = (p) => p.replace(/\\/g, '/');
const normalize = (s) => s.replace(/\r\n/g, '\n');
// canonical compare: key order must not decide "hand-edited"
const canonical = (v) =>
  JSON.stringify(v, (_, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  );

// ---- verify pass: every refusal happens BEFORE any write ----
if (!existsSync(target)) fail(`init REFUSED: target '${target}' does not exist`, 2);
const mcpServerEntry = join(pluginRoot, 'packages', 'mcp-server', 'dist', 'main.js');
if (!existsSync(mcpServerEntry)) fail('init REFUSED: MCP server not built — run `npm run build` in the plugin first', 2);
for (const rel of ['.sterling', '.sterling/runs', 'docs', 'docs/briefs', '.claude', '.claude/agents']) {
  const p = join(target, rel);
  if (existsSync(p) && !statSync(p).isDirectory()) {
    fail(`init REFUSED (destructive): '${rel}' exists as a file but the manifest requires a directory — refusing to replace it`, 2);
  }
}

// recorded config = the declaration source on re-runs (§12 ensure-manifest)
const configPath = join(target, '.sterling', 'config.json');
let recorded;
if (existsSync(configPath)) {
  try {
    recorded = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (e) {
    fail(`init REFUSED (destructive to fix): .sterling/config.json exists but does not validate — cannot verify, will not overwrite. Repair or delete it first. ${e.message}`, 2);
  }
}
if (!recorded) {
  if (!backupPathFlag && !backupOptOutFlag) {
    fail('init REFUSED: a backup path is required, or an EXPLICIT opt-out (--backup-opt-out) — the knowledge base must not live in exactly one gitignored file (§2.3)', 2);
  }
  if (!declaredToolchains.length) fail('init REFUSED: at least one --toolchain <adapter>:<globs> declaration is required (§9.1)', 2);
  if (!stackTagsFlag.length) fail('init REFUSED: --stack-tags is required (ask, don’t guess — §12 mini-grill)', 2);
}

// effective declarations: recorded config wins; flags only seed a fresh config
const baked = recorded ? recorded.toolchains : await resolveToolchains(declaredToolchains); // throws loudly on unregistered adapters
const eff = recorded
  ? {
      stackTags: recorded.stack_tags,
      domainPaths: recorded.domain_paths, // §3.3 line 94 per-tag path overrides
      backupPath: recorded.backup_path, // stored absolute
      backupOptOut: recorded.backup_opt_out,
      projectName: recorded.project_name ?? projectNameFlag ?? 'project',
      splitRatio: recorded.tui_split_ratio,
    }
  : {
      stackTags: stackTagsFlag,
      domainPaths: {}, // default per-user root; overrides are a hand-edited config concern
      // stored ABSOLUTE: disposal must hit the same place regardless of caller cwd.
      // backupPathForRuntime first rewrites a Windows drive path (C:\.../C:/...)
      // to /mnt form under WSL, so resolve() treats it as absolute instead of as
      // a relative path that lands inside the repo (the r-dd88 junk-dir bug).
      backupPath: backupPathFlag ? fwd(resolve(target, backupPathForRuntime(backupPathFlag))) : undefined,
      backupOptOut: backupOptOutFlag,
      projectName: projectNameFlag ?? 'project',
      splitRatio: undefined, // default from schema below
    };

// Every Sterling-initialized project mounts a universal `sterling` domain so
// general Sterling-tooling knowledge (gotchas, conventions, anti_patterns about
// using Sterling itself) is shared across ALL projects (decision 47be4388). It
// is force-added to the §3.3 mount manifest regardless of what the project
// declares — deduped, ordered AFTER the project's own tags so project/tech
// knowledge still ranks ahead of the shared tooling domain.
const UNIVERSAL_DOMAIN = 'sterling';
eff.stackTags = [...eff.stackTags.filter((t) => t !== UNIVERSAL_DOMAIN), UNIVERSAL_DOMAIN];

const expectedConfig = parseConfig({
  ...JSON.parse(readFileSync(join(pluginRoot, 'templates', 'default-config.json'), 'utf8')),
  toolchains: baked,
  stack_tags: eff.stackTags,
  domain_paths: eff.domainPaths,
  // mirror the recorded name on re-runs so a pre-project_name config can still match
  ...((recorded ? recorded.project_name : eff.projectName) !== undefined
    ? { project_name: recorded ? recorded.project_name : eff.projectName }
    : {}),
  ...(eff.backupPath ? { backup_path: eff.backupPath } : { backup_opt_out: eff.backupOptOut }),
});
if (eff.splitRatio === undefined) eff.splitRatio = expectedConfig.tui_split_ratio;

// flags passed on a re-run that contradict the recorded config are reported,
// never silently applied — the config may be tuned; editing it is the owner's act
const notes = [];
if (recorded) {
  const flagDiffs = [];
  // ignore the init-managed universal domain on both sides — omitting `sterling` is not a contradiction
  const stripUniversal = (tags) => tags.filter((t) => t !== UNIVERSAL_DOMAIN);
  if (stackTagsFlag.length && canonical(stripUniversal(stackTagsFlag)) !== canonical(stripUniversal(recorded.stack_tags))) flagDiffs.push('--stack-tags');
  if (declaredToolchains.length && canonical(declaredToolchains) !== canonical(recorded.toolchains.map((t) => ({ adapter: t.adapter, path_globs: t.path_globs })))) flagDiffs.push('--toolchain');
  if (backupPathFlag && fwd(resolve(target, backupPathForRuntime(backupPathFlag))) !== recorded.backup_path) flagDiffs.push('--backup-path');
  if (backupOptOutFlag && !recorded.backup_opt_out) flagDiffs.push('--backup-opt-out');
  if (projectNameFlag && recorded.project_name && projectNameFlag !== recorded.project_name) flagDiffs.push('--project-name');
  if (flagDiffs.length) {
    notes.push(`note: ${flagDiffs.join(', ')} differ(s) from the recorded config — NOT applied; edit .sterling/config.json directly if the change is intended`);
  }
}

// ---- §12 manifest, in order: per-item verify → create absent → skip matching → leave-and-report ----
const items = []; // { item, status: created|matches|differs|exists|refused|refreshed, detail }
const warns = [];

// directories: a present directory is simply `exists` (a dir cannot be hand-edited)
for (const [label, leaf] of [['.sterling/ (+runs/)', '.sterling/runs'], ['docs/briefs/', 'docs/briefs']]) {
  const existed = existsSync(join(target, leaf));
  mkdirSync(join(target, leaf), { recursive: true });
  items.push({ item: label, status: existed ? 'exists' : 'created', detail: '' });
}

// config: created from declarations | matches defaults+declarations | tuned/hand-edited → left
const backupDetail = eff.backupPath ? eff.backupPath : 'OPTED OUT (recorded; snapshots will skip loudly)';
if (!recorded) {
  writeFileSync(configPath, JSON.stringify(expectedConfig, null, 2));
  items.push({ item: '.sterling/config.json', status: 'created', detail: `${baked.map((t) => t.adapter).join(', ')} toolchain(s); stack tags [${eff.stackTags.join(', ')}]; backup ${backupDetail}` });
  for (const tc of baked) {
    for (const [cap, present] of Object.entries(tc.capabilities ?? {})) {
      if (!present) warns.push(`warn: ${tc.adapter}: no ${cap} capability — ${cap} checks will skip loudly (§9.1)`);
    }
  }
} else if (!recorded.stack_tags.includes(UNIVERSAL_DOMAIN)) {
  // managed mutation (decision 47be4388): every project mounts the universal
  // `sterling` domain. Surgically ADD it to the recorded config, preserving every
  // hand-tuned field — NOT a regenerate-from-defaults (that would clobber tunings).
  const updated = parseConfig({ ...recorded, stack_tags: eff.stackTags });
  writeFileSync(configPath, JSON.stringify(updated, null, 2));
  items.push({ item: '.sterling/config.json', status: 'refreshed', detail: `added the universal '${UNIVERSAL_DOMAIN}' domain to stack tags (now [${updated.stack_tags.join(', ')}])` });
} else if (canonical(recorded) === canonical(expectedConfig)) {
  items.push({ item: '.sterling/config.json', status: 'matches', detail: 'defaults + recorded declarations' });
} else {
  items.push({ item: '.sterling/config.json', status: 'differs', detail: 'left untouched (tuned or hand-edited) — declarations were read from it' });
}

// store: data, never recreated or compared — present means leave it alone
const dbPath = join(target, '.sterling', 'sterling.db');
if (existsSync(dbPath)) {
  items.push({ item: '.sterling/sterling.db', status: 'exists', detail: 'data store — left as-is, never recreated' });
} else {
  const { SterlingStore } = await import('@sterling/store');
  new SterlingStore(dbPath).close();
  items.push({ item: '.sterling/sterling.db', status: 'created', detail: 'WAL, FTS5' });
}

// CLAUDE.md from the shipped template — specified content, never improvised,
// NEVER clobbered: a differing CLAUDE.md is the human's; merging is their act.
const expectedClaudeMd = readFileSync(join(pluginRoot, 'templates', 'target-claude-md.md'), 'utf8')
  .replaceAll('{{PROJECT_NAME}}', eff.projectName)
  .replaceAll('{{STACK_TAGS}}', eff.stackTags.join(', '))
  .replaceAll('{{TOOLCHAINS}}', baked.map((t) => `${t.adapter} (${t.path_globs.join(', ')})`).join('; '))
  .replaceAll('{{DOMAINS}}', eff.stackTags.length
    ? eff.stackTags.map((t) => eff.domainPaths[t] ?? `~/.sterling/domains/${t}/`).join(', ') + ' — created lazily on first need (§2.3)'
    : '(none — declare stack tags to mount domain stores)')
  .replaceAll('{{BACKUP_PATH}}', eff.backupPath ? eff.backupPath : '(opted out — recorded)')
  .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
const claudeMdPath = join(target, 'CLAUDE.md');
if (!existsSync(claudeMdPath)) {
  writeFileSync(claudeMdPath, expectedClaudeMd);
  items.push({ item: 'CLAUDE.md', status: 'created', detail: 'from templates/target-claude-md.md' });
} else if (normalize(readFileSync(claudeMdPath, 'utf8')) === normalize(expectedClaudeMd)) {
  items.push({ item: 'CLAUDE.md', status: 'matches', detail: 'generated content, unmodified' });
} else {
  items.push({ item: 'CLAUDE.md', status: 'differs', detail: 'left untouched — merge the conductor contract by hand (template: templates/target-claude-md.md)' });
}

// WSL/tmux launchers (§11, decision bb5e25cd): all projects are WSL (company
// policy), so init generates the new-way launchers — a thin Windows .bat that
// double-clicks into `wt -> wsl --cd <project> -> bash -lic ./sterling-launch.sh`,
// plus the per-project tmux launcher sterling-launch.sh (claude left, TUI right).
// node/claude are detected at RUNTIME inside the .sh; the .bat needs no exe paths.
const toWindowsPath = (p) => {
  // /mnt/c/Users/cuj/X -> C:\Users\cuj\X (WSL drvfs); else just backslash-ize
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
};
// tmux session names forbid '.'/':' and choke on spaces — bake a sanitized,
// per-project name so multiple projects run at once but never the same one twice
const sanitizeSession = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
const winProjectDir = toWindowsPath(fwd(target));
const sessionName = `sterling-${sanitizeSession(basename(target))}`;
const splitPercent = Math.round(eff.splitRatio * 100);
const tuiBundle = fwd(join(pluginRoot, 'packages', 'tui', 'bundle', 'sterling-tui.mjs'));
// Native-Windows launcher (decision: revive the native split as a SECOND launcher).
// init runs under WSL node, so the Windows node path is found via `where.exe node`
// (interop) — requires the user to have the node dir on the Windows PATH.
// STERLING_WIN_NODE overrides detection (test isolation; mirrors STERLING_REGISTRY_DB).
const whereWin = (exe) => {
  const r = spawnSync('where.exe', [exe], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0];
};
// STERLING_WIN_NODE, when DEFINED (even empty), bypasses where.exe detection:
// a path forces that path; '' forces the skip path. Undefined → auto-detect.
const winNode = process.env.STERLING_WIN_NODE !== undefined ? process.env.STERLING_WIN_NODE : whereWin('node');
const winTuiBundle = toWindowsPath(tuiBundle);
const winPluginDir = toWindowsPath(fwd(pluginRoot));
const winMcpServerEntry = toWindowsPath(fwd(mcpServerEntry)); // Windows path to dist/main.js for native-claude MCP
const splitRatio01 = String(eff.splitRatio); // wt split-pane --size wants a 0–1 float
// the .sh is bash — ALWAYS LF (a CRLF shebang/line breaks bash); the .bat files
// are ALWAYS CRLF (cmd.exe misparses LF-only batch files), regardless of eol config
const lf = (s) => s.replace(/\r\n/g, '\n');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// (1) the tmux launcher — the actual split lives here; both .bat files call it
const expectedTmuxLauncher = lf(
  readFileSync(join(pluginRoot, 'templates', 'launcher-tmux.sh'), 'utf8')
    .replaceAll('{{SESSION}}', sessionName)
    .replaceAll('{{PLUGIN_DIR}}', fwd(pluginRoot))
    .replaceAll('{{TUI_BUNDLE}}', tuiBundle)
    .replaceAll('{{SPLIT_RATIO}}', String(splitPercent))
);
const tmuxLauncherPath = join(target, 'sterling-launch.sh');
if (!existsSync(tmuxLauncherPath)) {
  writeFileSync(tmuxLauncherPath, expectedTmuxLauncher);
  items.push({ item: 'sterling-launch.sh', status: 'created', detail: `tmux session ${sessionName}, ${splitPercent}% TUI pane` });
} else if (normalize(readFileSync(tmuxLauncherPath, 'utf8')) === normalize(expectedTmuxLauncher)) {
  items.push({ item: 'sterling-launch.sh', status: 'matches', detail: 'generated content unchanged' });
} else {
  items.push({ item: 'sterling-launch.sh', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (2) the double-click Windows entry: Windows Terminal -> WSL -> the tmux launcher
const expectedLauncher = crlf(
  readFileSync(join(pluginRoot, 'templates', 'launcher-win.bat'), 'utf8')
    .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
);
const launcherPath = join(target, 'sterling.bat');
if (!existsSync(launcherPath)) {
  writeFileSync(launcherPath, expectedLauncher);
  items.push({ item: 'sterling.bat', status: 'created', detail: `double-click -> wsl ${winProjectDir}` });
} else if (normalize(readFileSync(launcherPath, 'utf8')) === normalize(expectedLauncher)) {
  items.push({ item: 'sterling.bat', status: 'matches', detail: 'unchanged' });
} else {
  items.push({ item: 'sterling.bat', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (3) the §13 dashboard re-opener: re-adds the TUI pane to the running session
const expectedTuiLauncher = crlf(
  readFileSync(join(pluginRoot, 'templates', 'tui-win.bat'), 'utf8')
    .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
);
const tuiLauncherPath = join(target, 'tui.bat');
if (!existsSync(tuiLauncherPath)) {
  writeFileSync(tuiLauncherPath, expectedTuiLauncher);
  items.push({ item: 'tui.bat', status: 'created', detail: 'double-click -> ./sterling-launch.sh tui' });
} else if (normalize(readFileSync(tuiLauncherPath, 'utf8')) === normalize(expectedTuiLauncher)) {
  items.push({ item: 'tui.bat', status: 'matches', detail: 'unchanged' });
} else {
  items.push({ item: 'tui.bat', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (4) the FULLY-NATIVE Windows entry (decision: a SECOND launcher beside the WSL
// sterling.bat — partially reverses bb5e25cd): a wt split running native claude.exe
// (left) + the TUI on native Windows node (right), no WSL. Needs the Windows node
// path; when init can't resolve it (node not on the Windows PATH), the launcher is
// SKIPPED loudly (P5) without blocking the rest of init.
let expectedNativeLauncher;
const nativeLauncherPath = join(target, 'sterling-windows.bat');
if (winNode) {
  // P5 (AC8) snapshot bridge: the native launcher's wsl.exe step runs this script
  // on the WSL side (POSIX paths — it executes inside WSL bash). --win-domains-root
  // is computed AT RUNTIME from %USERPROFILE% via wslpath (no home baked in here).
  const snapshotScriptPosix = fwd(join(pluginRoot, 'scripts', 'snapshot-domains-for-windows.mjs'));
  expectedNativeLauncher = crlf(
    readFileSync(join(pluginRoot, 'templates', 'launcher-win-native.bat'), 'utf8')
      .replaceAll('{{WIN_PLUGIN_DIR}}', winPluginDir)
      .replaceAll('{{WIN_NODE}}', winNode)
      .replaceAll('{{WIN_TUI_BUNDLE}}', winTuiBundle)
      .replaceAll('{{SPLIT_RATIO}}', splitRatio01)
      .replaceAll('{{SNAPSHOT_SCRIPT}}', snapshotScriptPosix)
      .replaceAll('{{PROJECT_DIR_POSIX}}', fwd(target))
  );
  if (!existsSync(nativeLauncherPath)) {
    writeFileSync(nativeLauncherPath, expectedNativeLauncher);
    items.push({ item: 'sterling-windows.bat', status: 'created', detail: `native claude.exe + Windows-node TUI, ${splitRatio01} split` });
  } else if (normalize(readFileSync(nativeLauncherPath, 'utf8')) === normalize(expectedNativeLauncher)) {
    items.push({ item: 'sterling-windows.bat', status: 'matches', detail: 'unchanged' });
  } else {
    items.push({ item: 'sterling-windows.bat', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
  }
} else {
  items.push({ item: 'sterling-windows.bat', status: 'skipped', detail: 'Windows node not found via `where.exe node` — add the node dir to the Windows PATH and re-run init to generate the native launcher' });
}

// agent installation (§2.2) via the §13 sync semantics: installed | refreshed |
// up_to_date | locally-modified left | refuse-on-local-modification
const vars = { NODE: `"${fwd(process.execPath)}"`, HOOKS_DIR: fwd(join(pluginRoot, 'hooks')) };
const { report: agentReport } = syncAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(target, '.claude', 'agents'),
  pluginVersion: JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version,
  now: new Date().toISOString(),
  vars,
  // config.models is authoritative (98064d77): the config init just wrote/read
  // resolves {{MODEL}}/{{EFFORT}} per agent. `recorded` on a re-run, else the
  // freshly written `expectedConfig` — both are parsed SterlingConfig with .models.
  config: recorded ?? expectedConfig,
});
const agentInstructions = [];
for (const a of agentReport) {
  const map = {
    installed: { status: 'created', detail: 'installed with version/hash header' },
    refreshed: { status: 'refreshed', detail: 'clean install, newer template — regenerated' },
    up_to_date: { status: 'matches', detail: 'template hash + content hash match' },
    locally_modified_up_to_date: { status: 'differs', detail: 'locally modified, template unchanged — left untouched' },
    refused_local_modification: { status: 'refused', detail: 'locally modified AND template changed — overwrite refused (see /sterling:sync-agents guidance below)' },
    foreign_file: { status: 'refused', detail: 'not Sterling-generated — never overwritten (see guidance below)' },
  }[a.status];
  items.push({ item: `.claude/agents/${a.name}.md`, status: map.status, detail: map.detail });
  if (a.instruction) agentInstructions.push(a.instruction);
}
const restartNeeded = agentReport.some((a) => a.status === 'installed' || a.status === 'refreshed');

// MCP packaging (decision 097851ed, refined): the Sterling MCP server is declared
// ONCE as the PLUGIN's server — but NOT via a root .mcp.json. A root .mcp.json is
// BOTH auto-discovered by the plugin AND read as Sterling-self's project-scope config
// (the dual-role), and bare ${CLAUDE_PROJECT_DIR} does not substitute in project scope
// → a second, empty-store server. Instead the plugin manifest (.claude-plugin/plugin.json
// mcpServers) references .claude-plugin/sterling-mcp.json, read ONLY through the manifest
// and never as a project config — so the dual-role cannot exist. The store stays
// ${CLAUDE_PROJECT_DIR}/.sterling/sterling.db, substituted at server spawn to EACH
// consuming project's own store. command + server entry are absolute (machine-detected)
// → that file is gitignored + regenerable; the manifest reference is portable + committed.
// A consuming project still gets NO .mcp.json (the plugin carries the declaration).
const mcpPath = join(target, '.mcp.json');
const pluginMcpConfigPath = join(target, '.claude-plugin', 'sterling-mcp.json');
const pluginMcpEntry = {
  command: process.execPath,
  args: [fwd(mcpServerEntry), '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'],
};
const isOurMcpEntry = (e) =>
  e && typeof e === 'object' && e.command === process.execPath && Array.isArray(e.args) && e.args[0] === fwd(mcpServerEntry);
const readMcp = () => {
  try {
    const m = JSON.parse(readFileSync(mcpPath, 'utf8'));
    if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new Error('not an object');
    return m;
  } catch {
    return undefined;
  }
};
if (fwd(target) === fwd(pluginRoot)) {
  // THE source/plugin repo: the plugin manifest references this generated MCP config.
  const desired = { mcpServers: { sterling: pluginMcpEntry } };
  if (!existsSync(pluginMcpConfigPath)) {
    mkdirSync(dirname(pluginMcpConfigPath), { recursive: true });
    writeFileSync(pluginMcpConfigPath, JSON.stringify(desired, null, 2));
    items.push({ item: '.claude-plugin/sterling-mcp.json', status: 'created', detail: 'plugin MCP config (referenced by plugin.json mcpServers) — binds each project to its own store via ${CLAUDE_PROJECT_DIR}' });
  } else {
    let existing;
    try { existing = JSON.parse(readFileSync(pluginMcpConfigPath, 'utf8')); } catch { existing = undefined; }
    if (existing && canonical(existing) === canonical(desired)) {
      items.push({ item: '.claude-plugin/sterling-mcp.json', status: 'matches', detail: 'plugin MCP config as generated' });
    } else {
      items.push({ item: '.claude-plugin/sterling-mcp.json', status: 'differs', detail: 'differs from generated — left untouched (delete to regenerate)' });
    }
  }
  // ALSO the native-claude Windows MCP config (option B, decision a756e5d9 family):
  // sterling-windows.bat launches claude.exe with `--mcp-config <this> --strict-mcp-config`
  // so NATIVE claude runs the MCP server on the WINDOWS node — the plugin's WSL-node
  // sterling-mcp.json cannot run under native claude (-32000). Generated only here (the
  // plugin repo), referenced by every project's launcher; store stays ${CLAUDE_PROJECT_DIR}.
  // Skipped loudly (P5) when no Windows node resolved.
  const winMcpConfigPath = join(target, '.claude-plugin', 'sterling-mcp-win.json');
  if (winNode) {
    const desiredWin = { mcpServers: { sterling: { command: winNode, args: [winMcpServerEntry, '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'] } } };
    if (!existsSync(winMcpConfigPath)) {
      mkdirSync(dirname(winMcpConfigPath), { recursive: true });
      writeFileSync(winMcpConfigPath, JSON.stringify(desiredWin, null, 2));
      items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'created', detail: 'native-claude MCP config (Windows node) — referenced by sterling-windows.bat --mcp-config' });
    } else {
      let existingWin;
      try { existingWin = JSON.parse(readFileSync(winMcpConfigPath, 'utf8')); } catch { existingWin = undefined; }
      if (existingWin && canonical(existingWin) === canonical(desiredWin)) {
        items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'matches', detail: 'native-claude MCP config as generated' });
      } else {
        items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'differs', detail: 'differs from generated — left untouched (delete to regenerate)' });
      }
    }
  } else {
    items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'skipped', detail: 'Windows node not found via `where.exe node` — native-claude MCP config not generated (add the node dir to Windows PATH and re-init)' });
  }
  // a root .mcp.json must NOT exist in the plugin repo: it would be auto-discovered by
  // the plugin (double-declaring sterling) AND read as project scope (the empty-store
  // dual-role). Remove our own generated one; report anything else loudly.
  if (existsSync(mcpPath)) {
    const mcp = readMcp();
    if (mcp && mcp.mcpServers && isOurMcpEntry(mcp.mcpServers.sterling) && Object.keys(mcp.mcpServers).length === 1) {
      unlinkSync(mcpPath);
      items.push({ item: '.mcp.json', status: 'created', detail: 'removed — the plugin now references .claude-plugin/sterling-mcp.json; a root .mcp.json reintroduces the empty-store dual-role' });
    } else {
      items.push({ item: '.mcp.json', status: 'differs', detail: 'unexpected root .mcp.json in the plugin repo — remove by hand (it reintroduces the empty-store project server)' });
    }
  }
} else {
  // a consuming project: the plugin already declares sterling, bound to THIS
  // project's store via ${CLAUDE_PROJECT_DIR}. Never write a per-project entry
  // (it double-registers); remove a stale init-generated one, keep foreign servers.
  const mcp = existsSync(mcpPath) ? readMcp() : undefined;
  if (!existsSync(mcpPath)) {
    items.push({ item: '.mcp.json', status: 'matches', detail: 'not written — the plugin declares sterling, bound to this project via ${CLAUDE_PROJECT_DIR}' });
  } else if (!mcp) {
    items.push({ item: '.mcp.json', status: 'differs', detail: 'exists but is not a parseable object — left untouched' });
  } else if (isOurMcpEntry(mcp.mcpServers?.sterling)) {
    delete mcp.mcpServers.sterling;
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
    items.push({ item: '.mcp.json', status: 'created', detail: 'removed the redundant per-project sterling entry — the plugin now declares it (other servers preserved)' });
  } else if (mcp.mcpServers?.sterling) {
    items.push({ item: '.mcp.json', status: 'differs', detail: 'a hand-edited sterling entry exists — left untouched (the plugin also declares sterling; reconcile by hand)' });
  } else {
    items.push({ item: '.mcp.json', status: 'matches', detail: 'no per-project sterling entry — the plugin declares it' });
  }
}

// hook registrations: the project-level §6 set ships in the PLUGIN's
// hooks.json and activates with the plugin — init does not duplicate it.
items.push({ item: 'hooks (§6 set)', status: 'matches', detail: 'active via the plugin (hooks/hooks.json) — not duplicated into the project' });

// gitignore entries (§2.3/§11/§12): per-entry ensure — appending is non-destructive
const gitignorePath = join(target, '.gitignore');
const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
const entries = ['.sterling/', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', '.claude/agents/'];
// the SOURCE/plugin repo's generated MCP config is machine-specific → gitignore it
// (consuming projects never get one — the plugin carries its own declaration).
if (fwd(target) === fwd(pluginRoot)) entries.push('.claude-plugin/sterling-mcp.json', '.claude-plugin/sterling-mcp-win.json');
if (eff.backupPath) {
  const root = fwd(target);
  if (eff.backupPath === root || eff.backupPath.startsWith(root + '/')) {
    entries.push(eff.backupPath === root ? '/' : eff.backupPath.slice(root.length + 1) + '/');
  }
}
const missing = entries.filter((e) => !existingIgnore.split(/\r?\n/).includes(e));
if (missing.length) {
  appendFileSync(gitignorePath, (existingIgnore && !existingIgnore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  items.push({ item: '.gitignore', status: 'created', detail: `appended: ${missing.join(', ')}` });
} else {
  items.push({ item: '.gitignore', status: 'matches', detail: 'all entries present' });
}

// dead-term check over the GENERATED content (§12) — rendered expected content
// every run (catches template rot), never the human's own files
for (const [label, content] of [['CLAUDE.md', expectedClaudeMd], ['sterling-launch.sh', expectedTmuxLauncher], ['sterling.bat', expectedLauncher], ['tui.bat', expectedTuiLauncher], ...(expectedNativeLauncher ? [['sterling-windows.bat', expectedNativeLauncher]] : [])]) {
  const hits = findDeadTerms(content);
  if (hits.length) fail(`init dead-term check FAILED in generated ${label}: ${hits.map((h) => h.match).join(', ')}`, 1);
}

// shared project registry (decision 8f9e6db2): note this project in the
// machine-global registry so the others are aware it exists. Upsert by repo_path,
// bound to the init event (P4); the H1 hook later touches last_seen_at per session.
const pluginPkg = (() => {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const registry = new ProjectRegistry(registryPath());
try {
  const already = registry.list().some((p) => p.repo_path === fwd(target));
  registry.register({
    repo_path: fwd(target),
    name: eff.projectName,
    stack_tags: eff.stackTags,
    toolchains: baked.map((t) => t.adapter),
    sterling_version: typeof pluginPkg.version === 'string' ? pluginPkg.version : null,
    at: new Date().toISOString(),
  });
  const siblings = registry.list().filter((p) => p.repo_path !== fwd(target)).length;
  items.push({
    item: 'project registry',
    status: already ? 'refreshed' : 'created',
    detail: `${already ? 'refreshed' : 'noted'} '${eff.projectName}' in the shared registry — ${siblings} sibling project${siblings === 1 ? '' : 's'}`,
  });
} finally {
  registry.close();
}

// ---- the per-item report table ----
const width = Math.max(...items.map((i) => i.item.length));
const statusWidth = Math.max(...items.map((i) => i.status.length));
console.log('item'.padEnd(width) + '  ' + 'status'.padEnd(statusWidth) + '  detail');
for (const i of items) {
  console.log(i.item.padEnd(width) + '  ' + i.status.padEnd(statusWidth) + '  ' + i.detail);
}
console.log('\ndead-term check: clean');
for (const line of warns) console.log(line);
for (const line of notes) console.log(line);
for (const instruction of agentInstructions) console.log('\n' + instruction);

if (restartNeeded) {
  console.log('\n' + RESTART_INSTRUCTION);
} else {
  console.log('\nno agent changes — no restart required');
}
