// Sterling on OpenCode 2: machine and project setup (decisions
// sterling-on-opencode-installs-global-plugins-plus-untracked-project-config,
// sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin and
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone).
// Init and sync-agents (so /sterling:update's fan-out and H1's post-update sync too)
// call setupOpenCode once per project. Every step is idempotent.
//
// 1. GLOBAL, once per machine, under <XDG_CONFIG_HOME or ~/.config>/opencode/plugins/:
//    sterling.js (server shim; 2.0.21 does not load a .mjs there) and sterling-tui/
//    (TUI plugin directory whose package.json exports './tui' to a shim tui.tsx). The
//    shims import <root>/opencode/sterling-server.mjs and the './tui' export of
//    <root>/opencode/sterling-tui/ IN PLACE: the server bundle finds the plugin root by
//    walking up from its own import.meta.url. Plus <home>/.sterling/opencode/
//    sterling-mcp.mjs, the MCP launcher every project's opencode.json names. All three
//    resolve the Sterling root at RUN time: the authoring clone's path is baked (a clone
//    does not move on update), an installed copy is the newest one the shared resolver
//    (scripts/lib/sterling-roots.mjs) finds in Claude Code's plugin cache or OpenCode's
//    npm cache, so no versioned install path is ever written to disk. A file of the same name that
//    Sterling did not write, or one edited since, is refused, never overwritten.
//    Also once per machine: a `codex` entry under mcp.servers in <config dir>/opencode.json,
//    written only for a Codex whose `mcp-server --help` prints mcp-server help.
// 2. PER PROJECT: <project>/.opencode/opencode.json gets the `sterling` local MCP entry,
//    the store-guard edit-deny rules and default_agent, merged into whatever else the
//    file holds. What Sterling writes under .opencode/ is kept out of git through a
//    managed block in .git/info/exclude (the committed .gitignore is never edited):
//    the whole /.opencode/ in a hobby project with nothing tracked there, otherwise
//    only Sterling's own paths, so a work project's committed portable agents
//    (.opencode/agents/<name>.md) stay committed.
// 3. The Sterling-FULL conductor (mode primary) and roster (implementor, researcher,
//    scout, reviewer, librarian) go to .opencode/agents/sterling/, which OpenCode 2.0.21 loads as
//    sterling/<name> (measured: {agent,agents}/**/*.md, the subdirectory becomes a name
//    prefix). Bare names would collide with the committed portable copies, and a
//    project .opencode/agents/<name>.md wins over every other same-named definition
//    (global agents/, project agent/, the config `agents` key), all measured.
//
// OpenCode not installed, or not 2.x: one loud skip line, nothing written.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstalledCopy } from './installed-copy.mjs';
import { RESOLVER_SOURCE as STERLING_RESOLVER_SOURCE } from './sterling-roots.mjs';
import { stampBody, verifyStamp } from './generated-marker.mjs';
import { sha256, loadRegistry } from './agent-distribution.mjs';
import { renderOpenCodeFullText } from './agent-fences.mjs';
import { renderOpenCodeAgent, parseOpenCodeHeader } from './opencode-agents.mjs';
import { ignoredPaths } from './git-ignore-check.mjs';
import { readProjectMode } from './handoff-projection.mjs';

export const STERLING_AGENTS_SUBDIR = '.opencode/agents/sterling';
export const PROJECT_CONFIG_REL = '.opencode/opencode.json';
export const CONDUCTOR_AGENT = 'sterling/conductor';
export const ROSTER = ['conductor', 'implementor', 'researcher', 'scout', 'reviewer', 'librarian'];
export const STORE_GUARD_PATTERNS = ['**/.sterling/sterling.db*', '.sterling/sterling.db*'];
const PACKAGE_MARKER = 'sterling-generated';
const EXCLUDE_BEGIN = '# >>> sterling opencode (managed by Sterling init/update; per-user files, never committed)';
const EXCLUDE_END = '# <<< sterling opencode';
const FULL_HEADER_RE = /^<!-- sterling-full renderer=opencode-full\/1 template=(\S+) template_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) -->$/m;

const fwd = (p) => p.replace(/\\/g, '/');
const normalize = (s) => s.replace(/\r\n/g, '\n');

/** OpenCode's global config dir: <XDG_CONFIG_HOME or <home>/.config>/opencode. */
export function opencodeConfigDir({ env = process.env, home = homedir() } = {}) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
}

/** Where the MCP launcher lives: outside OpenCode's config dir, so nothing scans it. */
export function mcpLauncherPath({ home = homedir() } = {}) {
  return join(home, '.sterling', 'opencode', 'sterling-mcp.mjs');
}

/** `opencode --version` → { installed, version, major } or { installed: false, reason }. */
export function probeOpenCode({ env = process.env } = {}) {
  const r = spawnSync('opencode', ['--version'], { encoding: 'utf8', env, timeout: 20_000 });
  if (r.error) return { installed: false, reason: r.error.code === 'ENOENT' ? 'no `opencode` on PATH' : `opencode --version could not run (${r.error.message})` };
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (r.status !== 0 || !m) return { installed: false, reason: `opencode --version exited ${r.status} without a version: ${`${r.stdout}${r.stderr}`.trim().slice(0, 200)}` };
  return { installed: true, version: m[0], major: Number(m[1]) };
}

// ---------- generated files -------------------------------------------------

// Builtins-only source inlined into every generated file: the shared resolver
// (sterling-roots.mjs) plus a wrapper that fails loud with the OpenCode remedy.
const RESOLVER_SOURCE = `${STERLING_RESOLVER_SOURCE}
function sterlingInstallRoot() {
  const found = newestInstalledSterling();
  if (!found) throw new Error('Sterling: ' + sterlingNotFoundMessage('opencode'));
  return found.root;
}
`;

const IMPORTS = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "import { homedir } from 'node:os';",
  "import { dirname, join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
].join('\n');

function rootExpr(pluginRoot, installed) {
  return installed ? 'sterlingInstallRoot()' : JSON.stringify(fwd(resolve(pluginRoot)));
}

/** The one stderr line a shim prints when no Sterling can be resolved, naming the file to remove. */
function notFoundLine(what, shimPath) {
  return `console.error('Sterling not found; ${what} is off. Remove ' + ${JSON.stringify(fwd(shimPath))} + ' or reinstall Sterling (' + String((err && err.message) || err) + ')');`;
}

export function renderServerShim(pluginRoot, installed, shimPath) {
  return stampBody(`// Sterling OpenCode server shim — generated by /sterling:init and /sterling:update; do not edit.
${IMPORTS}
${RESOLVER_SOURCE}
const sterlingRoot = () => ${rootExpr(pluginRoot, installed)};

export default {
  id: 'sterling',
  async setup(ctx) {
    const dir = ctx && ctx.location && ctx.location.directory;
    // Non-Sterling projects load nothing.
    if (!dir || !existsSync(join(dir, '.sterling', 'sterling.db'))) return;
    let root;
    try {
      root = sterlingRoot();
    } catch (err) {
      ${notFoundLine('the knowledge loop', shimPath)}
      return;
    }
    const entry = join(root, 'opencode', 'sterling-server.mjs');
    if (!existsSync(entry)) {
      throw new Error('Sterling: ' + entry + ' is missing — the Sterling at ' + root + ' has no OpenCode server plugin; update Sterling, then run /sterling:update.');
    }
    const plugin = (await import(pathToFileURL(entry).href)).default;
    if (!plugin || typeof plugin.setup !== 'function') {
      throw new Error('Sterling: ' + entry + ' has no default export with setup(ctx).');
    }
    return plugin.setup(ctx);
  },
};
`, '//');
}

export function renderTuiShim(pluginRoot, installed, shimDir) {
  return stampBody(`// Sterling OpenCode TUI shim — generated by /sterling:init and /sterling:update; do not edit.
${IMPORTS}
${RESOLVER_SOURCE}
async function loadSterlingTui() {
  const pkgDir = join(${rootExpr(pluginRoot, installed)}, 'opencode', 'sterling-tui');
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('Sterling: ' + pkgPath + ' is missing — this Sterling has no OpenCode TUI plugin; update Sterling, then run /sterling:update.');
  }
  const exp = (JSON.parse(readFileSync(pkgPath, 'utf8')).exports || {})['./tui'];
  const rel = typeof exp === 'string' ? exp : exp && (exp.import || exp.default);
  if (typeof rel !== 'string') throw new Error('Sterling: ' + pkgPath + " has no exports['./tui'].");
  return (await import(pathToFileURL(join(pkgDir, rel)).href)).default;
}

// The nearest .sterling/sterling.db at or above dir decides whether this is a Sterling project.
function inSterlingProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.sterling', 'sterling.db'))) return true;
    if (dirname(d) === d) return false;
  }
}

// A missing Sterling must not break OpenCode at import: the failure is kept and
// reported once, from setup.
let plugin;
let loadError;
try {
  plugin = await loadSterlingTui();
} catch (err) {
  loadError = err;
}

export default {
  id: (plugin && plugin.id) || 'sterling.dashboard',
  setup(api) {
    if (loadError) {
      const err = loadError;
      ${notFoundLine('the dashboard', shimDir)}
      return () => {};
    }
    // Non-Sterling projects get no slot, command or route.
    const dir = (api && api.location && api.location.directory) || process.cwd();
    if (!inSterlingProject(dir)) return () => {};
    return plugin.setup(api);
  },
};
`, '//');
}

const TUI_PACKAGE_NOTE = 'Sterling OpenCode TUI shim; written by /sterling:init and /sterling:update';

// JSON has no comments, so the stamp is a field: the hash covers the object without it.
const tuiPackageHash = (obj) => sha256(JSON.stringify(obj, null, 2));

export function renderTuiPackageJson() {
  const pkg = { name: 'sterling-tui', private: true, type: 'module', exports: { './tui': './tui.tsx' } };
  return `${JSON.stringify({ ...pkg, [PACKAGE_MARKER]: `${TUI_PACKAGE_NOTE}; content_hash=${tuiPackageHash(pkg)}` }, null, 2)}\n`;
}

/** 'foreign' (no Sterling marker), 'edited' (marker hash no longer matches), or 'ours'. A pre-stamp marker without a hash counts as ours. */
function tuiPackageState(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return 'foreign';
  }
  const marker = obj && typeof obj === 'object' ? obj[PACKAGE_MARKER] : undefined;
  if (typeof marker !== 'string') return 'foreign';
  const m = /content_hash=([0-9a-f]{64})$/.exec(marker);
  if (!m) return 'ours';
  const rest = { ...obj };
  delete rest[PACKAGE_MARKER];
  return tuiPackageHash(rest) === m[1] ? 'ours' : 'edited';
}

export function renderMcpLauncher(pluginRoot, installed) {
  return stampBody(`// Sterling MCP launcher for OpenCode — generated by /sterling:init and /sterling:update; do not edit.
${IMPORTS}
${RESOLVER_SOURCE}
const entry = join(${rootExpr(pluginRoot, installed)}, 'mcp', 'sterling-mcp.mjs');
if (!existsSync(entry)) {
  console.error('sterling-mcp launcher: ' + entry + ' is missing — update Sterling, then run /sterling:update.');
  process.exit(3);
}
// The bundle reads process.argv.slice(2) (--store <path>), which this process shares.
await import(pathToFileURL(entry).href);
`, '//');
}

// One stamped file: created / matches / refreshed, or refused when the file is not
// Sterling's (no marker) or was edited since Sterling wrote it.
function ensureStampedFile(path, content, label) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { item: label, status: 'created' };
  }
  if (!statSync(path).isFile()) return refusal(label, `${fwd(path)} exists and is not a file`, `move it aside, then rerun /sterling:update`);
  const disk = normalize(readFileSync(path, 'utf8'));
  if (disk === content) return { item: label, status: 'matches' };
  const stamp = verifyStamp(disk, '//');
  if (stamp === null) return refusal(label, `${fwd(path)} exists and Sterling did not write it`, `rename or remove it (it would shadow Sterling's), then rerun /sterling:update`);
  if (!stamp.unmodified) return refusal(label, `${fwd(path)} was edited after Sterling wrote it`, `delete it so Sterling can regenerate it, then rerun /sterling:update`);
  writeFileSync(path, content);
  return { item: label, status: 'refreshed' };
}

function refusal(item, what, remedy) {
  return { item, status: 'refused', refused: true, detail: what, instruction: `REFUSED: ${what}. Sterling will not overwrite it. Remedy: ${remedy}.` };
}

export function installGlobal({ pluginRoot, installed, env = process.env, home = homedir() }) {
  const pluginsDir = join(opencodeConfigDir({ env, home }), 'plugins');
  const rows = [];
  rows.push(ensureStampedFile(join(pluginsDir, 'sterling.js'), renderServerShim(pluginRoot, installed, join(pluginsDir, 'sterling.js')), `${fwd(pluginsDir)}/sterling.js`));
  const tuiDir = join(pluginsDir, 'sterling-tui');
  const pkgPath = join(tuiDir, 'package.json');
  const pkgLabel = `${fwd(tuiDir)}/package.json`;
  const pkg = renderTuiPackageJson();
  const pkgState = existsSync(pkgPath) && statSync(pkgPath).isFile() ? tuiPackageState(normalize(readFileSync(pkgPath, 'utf8'))) : null;
  if (existsSync(tuiDir) && !statSync(tuiDir).isDirectory()) {
    rows.push(refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)} exists and is not a directory`, 'move it aside, then rerun /sterling:update'));
  } else if (pkgState === 'foreign') {
    rows.push(refusal(pkgLabel, `${fwd(tuiDir)}/ holds a package.json Sterling did not write`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`));
  } else if (pkgState === 'edited') {
    rows.push(refusal(pkgLabel, `${fwd(pkgPath)} was edited after Sterling wrote it`, `delete it so Sterling can regenerate it, then rerun /sterling:update`));
  } else if (existsSync(tuiDir) && !existsSync(pkgPath) && readdirSync(tuiDir).length > 0) {
    rows.push(refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)}/ exists with files Sterling did not write and no package.json`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`));
  } else {
    const before = existsSync(pkgPath) ? normalize(readFileSync(pkgPath, 'utf8')) : null;
    mkdirSync(tuiDir, { recursive: true });
    if (before !== pkg) writeFileSync(pkgPath, pkg);
    rows.push({ item: pkgLabel, status: before === null ? 'created' : before === pkg ? 'matches' : 'refreshed' });
    rows.push(ensureStampedFile(join(tuiDir, 'tui.tsx'), renderTuiShim(pluginRoot, installed, tuiDir), `${fwd(tuiDir)}/tui.tsx`));
  }
  rows.push(ensureStampedFile(mcpLauncherPath({ home }), renderMcpLauncher(pluginRoot, installed), fwd(mcpLauncherPath({ home }))));
  return rows;
}

// ---------- codex MCP (user scope) -------------------------------------------
// Board item parity-p4-codex-mcp-lanes-on-opencode-2-decision-7f83f57e-au. The entry
// shape is the one measured on 2.0.21 (finding
// codex-mcp-server-runs-under-opencode-2-0-21-servers-shape-october-2026): it lives
// under mcp.servers, because a legacy mcp.<name> entry carrying a timeout was dropped
// silently. A Codex qualifies only when `mcp-server --help` prints that subcommand's
// own help: 0.154+ exits 0 with the generic help (anti_pattern codex-mcp-probe-by-exit-status).

/** The pinned side install (finding codex-mcp-bridge-needs-codex-0-153-4-pinned-side-install), under home. */
export const PINNED_CODEX_REL = '.local/codex-mcp-0.153.4/bin/codex';
const PINNED_CODEX_INSTALL = 'npm i -g --prefix ~/.local/codex-mcp-0.153.4 @openai/codex@0.153.4';
const CODEX_PROBE_TIMEOUT_MS = 10_000;

const isFile = (p) => existsSync(p) && statSync(p).isFile();

/**
 * Codex binaries to try, best first: the one Claude Code's user-scope codex server
 * runs (<CLAUDE_CONFIG_DIR or home>/.claude.json, as init reads it), the pinned side
 * install, then every `codex` on PATH.
 */
function codexCandidates({ env, home }) {
  const out = [];
  const notes = [];
  const claudeJson = join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  if (isFile(claudeJson)) {
    let command;
    try {
      command = JSON.parse(readFileSync(claudeJson, 'utf8'))?.mcpServers?.codex?.command;
    } catch (err) {
      // Reported in the row; the other candidates still run.
      notes.push(`${fwd(claudeJson)} not read (${err.message})`);
    }
    if (typeof command === 'string' && isAbsolute(command)) out.push(command);
  }
  out.push(join(home, PINNED_CODEX_REL));
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) out.push(join(dir, 'codex'));
  return { candidates: [...new Set(out)].filter(isFile), notes };
}

/** The first candidate whose `mcp-server --help` prints mcp-server help, or { tried } when none does. */
export function resolveCodexMcp({ env = process.env, home = homedir(), nodeBinDir, spawnFn = spawnSync }) {
  const { candidates, notes } = codexCandidates({ env, home });
  const tried = [...notes];
  for (const command of candidates) {
    const r = spawnFn(command, ['mcp-server', '--help'], { encoding: 'utf8', timeout: CODEX_PROBE_TIMEOUT_MS, env: { ...env, PATH: codexPath(nodeBinDir) } });
    const help = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (!r.error && r.status === 0 && /\bcodex\s+mcp-server\b/i.test(help)) return { command };
    tried.push(`${fwd(command)} (${r.error ? r.error.message : r.status !== 0 ? `exit ${r.status}` : 'generic help, no mcp-server subcommand'})`);
  }
  return { tried };
}

const codexPath = (nodeBinDir) => `${fwd(nodeBinDir)}:/usr/local/bin:/usr/bin:/bin`;

/** The measured entry: PATH carries the node bin dir because codex is a `#!/usr/bin/env node` script. */
export function codexServerEntry(command, nodeBinDir) {
  return {
    type: 'local',
    command: [fwd(command), 'mcp-server'],
    environment: { PATH: codexPath(nodeBinDir) },
    timeout: { startup: 30000, execution: 900000 },
  };
}

/** Merge mcp.servers.codex into <opencode config dir>/opencode.json; every other key is kept. */
export function ensureCodexServer({ env = process.env, home = homedir(), nodeBinDir = dirname(process.execPath), spawnFn = spawnSync }) {
  const path = join(opencodeConfigDir({ env, home }), 'opencode.json');
  const label = `${fwd(path)} mcp.servers.codex`;
  const found = resolveCodexMcp({ env, home, nodeBinDir, spawnFn });
  if (!found.command) {
    const tried = found.tried.length ? `tried ${found.tried.join('; ')}` : 'no Codex binary found';
    return { item: label, status: 'skipped', detail: `codex MCP for OpenCode SKIPPED: no Codex whose \`mcp-server --help\` prints mcp-server help (${tried}). Install the pinned Codex (${PINNED_CODEX_INSTALL}), then run /sterling:update` };
  }
  let config = {};
  let before = null;
  if (existsSync(path)) {
    before = normalize(readFileSync(path, 'utf8'));
    try {
      config = JSON.parse(before);
    } catch (err) {
      return refusal(label, `${fwd(path)} is not valid JSON (${err.message})`, `fix or remove ${fwd(path)}, then rerun /sterling:update`);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return refusal(label, `${fwd(path)} is not a JSON object`, `fix or remove ${fwd(path)}, then rerun /sterling:update`);
  }
  const mcp = config.mcp ?? {};
  if (typeof mcp !== 'object' || Array.isArray(mcp)) return refusal(label, `${fwd(path)}: "mcp" is not an object`, `fix ${fwd(path)}, then rerun /sterling:update`);
  const servers = mcp.servers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) return refusal(label, `${fwd(path)}: "mcp.servers" is not an object`, `fix ${fwd(path)}, then rerun /sterling:update`);
  const want = codexServerEntry(found.command, nodeBinDir);
  const legacy = mcp.codex !== undefined ? '; a legacy mcp.codex entry is also present, which 2.0.21 drops silently when it carries a timeout' : '';
  if (servers.codex !== undefined) {
    if (JSON.stringify(servers.codex) === JSON.stringify(want)) return { item: label, status: 'matches', detail: `${fwd(found.command)}${legacy}` };
    return { item: label, status: 'skipped', detail: `kept: mcp.servers.codex is already set and differs from Sterling's (yours); Sterling's would be ${JSON.stringify(want)}${legacy}` };
  }
  config.mcp = { ...mcp, servers: { ...servers, codex: want } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { item: label, status: before === null ? 'created' : 'refreshed', detail: `${fwd(found.command)}${legacy}` };
}

// ---------- per project -----------------------------------------------------

function git(projectDir, args) {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args.join(' ')} could not run in ${fwd(projectDir)}: ${r.error.message}`);
  return r;
}

export function mcpCommand({ home = homedir() } = {}) {
  return ['node', '--disable-warning=ExperimentalWarning', fwd(mcpLauncherPath({ home })), '--store', '.sterling/sterling.db'];
}

/** Merge Sterling's keys into .opencode/opencode.json without touching any other key. */
export function ensureProjectConfig({ projectDir, home = homedir(), tracked, conductorOk = true }) {
  const rel = PROJECT_CONFIG_REL;
  const path = join(projectDir, rel);
  if (tracked.includes(rel)) {
    return refusal(rel, `${rel} is tracked by git, and Sterling's MCP entry names a per-user path that must not be committed`, `untrack it (git rm --cached ${rel} and commit), then rerun /sterling:update`);
  }
  let config = {};
  let before = null;
  if (existsSync(path)) {
    before = normalize(readFileSync(path, 'utf8'));
    try {
      config = JSON.parse(before);
    } catch (err) {
      return refusal(rel, `${rel} is not valid JSON (${err.message})`, `fix or remove ${rel}, then rerun /sterling:update`);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return refusal(rel, `${rel} is not a JSON object`, `fix or remove ${rel}, then rerun /sterling:update`);
    }
  }
  const notes = [];
  const mcp = config.mcp ?? {};
  if (typeof mcp !== 'object' || Array.isArray(mcp)) return refusal(rel, `${rel}: "mcp" is not an object`, `fix ${rel}, then rerun /sterling:update`);
  config.mcp = { ...mcp, sterling: { type: 'local', command: mcpCommand({ home }) } };
  // Store guard. A string value ("allow"/"ask") becomes the "*" rule so its meaning is
  // kept; Sterling's deny rules are re-added LAST so they win over any broader rule.
  const permission = config.permission ?? {};
  if (typeof permission !== 'object' || Array.isArray(permission)) return refusal(rel, `${rel}: "permission" is not an object`, `fix ${rel}, then rerun /sterling:update`);
  // The shape measured live on 2.0.21 (finding 25892d42): "*": "allow" first, then the
  // deny rules. An existing "*" (or a bare string, which becomes "*") is kept as is.
  let edit = permission.edit ?? { '*': 'allow' };
  if (typeof edit === 'string') edit = { '*': edit };
  if (typeof edit !== 'object' || Array.isArray(edit)) return refusal(rel, `${rel}: "permission.edit" is neither a string nor an object`, `fix ${rel}, then rerun /sterling:update`);
  const guarded = { '*': 'allow', ...Object.fromEntries(Object.entries(edit).filter(([k]) => !STORE_GUARD_PATTERNS.includes(k))) };
  for (const p of STORE_GUARD_PATTERNS) guarded[p] = 'deny';
  config.permission = { ...permission, edit: guarded };
  if (!conductorOk) {
    if (config.default_agent === undefined) notes.push(`default_agent not set: the ${CONDUCTOR_AGENT} agent file was refused`);
  } else if (config.default_agent === undefined) config.default_agent = CONDUCTOR_AGENT;
  else if (config.default_agent !== CONDUCTOR_AGENT) notes.push(`default_agent kept as ${JSON.stringify(config.default_agent)} (yours), so OpenCode does not start in ${CONDUCTOR_AGENT}`);
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) return { item: rel, status: 'matches', detail: notes.join('; ') || undefined };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return { item: rel, status: before === null ? 'created' : 'refreshed', detail: notes.join('; ') || 'sterling MCP entry, store-guard edit deny, default_agent' };
}

function excludeLines(wholeDir) {
  return wholeDir ? ['/.opencode/'] : [`/${PROJECT_CONFIG_REL}`, `/${STERLING_AGENTS_SUBDIR}/`];
}

/** Keep Sterling's .opencode files out of git via a managed block in .git/info/exclude. */
export function ensureExcluded({ projectDir, mode, tracked }) {
  const label = '.git/info/exclude';
  const wholeDir = mode === 'hobby' && tracked.length === 0;
  const want = [EXCLUDE_BEGIN, ...excludeLines(wholeDir), EXCLUDE_END].join('\n');
  const gp = git(projectDir, ['rev-parse', '--git-path', 'info/exclude']);
  if (gp.status !== 0) return { item: label, status: 'skipped', detail: `not a git work tree (${(gp.stderr || '').trim().split('\n')[0]}) — nothing to keep untracked` };
  const excludePath = resolve(projectDir, gp.stdout.trim());
  const current = existsSync(excludePath) ? normalize(readFileSync(excludePath, 'utf8')) : '';
  const begin = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END);
  if (begin !== -1 && end > begin) {
    const block = current.slice(begin, end + EXCLUDE_END.length);
    if (block === want) return { item: label, status: 'matches', detail: excludeLines(wholeDir).join(' ') };
    writeFileSync(excludePath, current.slice(0, begin) + want + current.slice(end + EXCLUDE_END.length));
    return { item: label, status: 'refreshed', detail: excludeLines(wholeDir).join(' ') };
  }
  const probe = ignoredPaths(projectDir, [PROJECT_CONFIG_REL, `${STERLING_AGENTS_SUBDIR}/conductor.md`]);
  if (probe.checked && probe.ignored.length === 2) {
    return { item: label, status: 'matches', detail: `already ignored (${[...new Set(probe.ignored.map((i) => i.rule))].join('; ')})` };
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${current}${sep}${want}\n`);
  return { item: label, status: 'created', detail: excludeLines(wholeDir).join(' ') };
}

// The conductor's OpenCode description: its template line names .claude/settings.json.
const CONDUCTOR_OPENCODE_DESCRIPTION = "Sterling's orchestrating main-session agent. Briefs, synthesizes, verifies, decides and commits; hands-on reading, implementing and reviewing go to subagents. Activated by default_agent \"sterling/conductor\" in the project's .opencode/opencode.json (written by /sterling:init and /sterling:update); never dispatched as a subagent.";

// Sterling-full permissions for the roles with no portable copy (no registry
// `opencode` block, so they never reach the committed set). They mirror the Claude
// tool grants: the reviewer has Read/Grep/Glob/Bash and store reads; the librarian
// has Read/Grep and the store tools, with no Edit, Write, Bash or web tool.
const FULL_PERMISSIONS = {
  reviewer: { edit: 'deny', webfetch: 'deny', task: 'deny' },
  librarian: { edit: 'deny', bash: 'deny', webfetch: 'deny', task: 'deny' },
};

// Roles that may write the store on OpenCode, as on Claude: every other subagent
// gets an explicit deny for each store-write tool.
const STORE_WRITERS = new Set(['conductor', 'librarian']);

/**
 * The store-write tools as OpenCode's permission keys name them (<mcp server>_<tool>,
 * the server entry being `sterling`), read from the implementor template's
 * disallowedTools, which is the one list of what a non-writing agent may not call.
 * Measured live on 2.0.21 (2026-10-02, stub `sterling` MCP server): the key
 * `sterling_knowledge_create: deny` removes exactly that tool from the agent, while
 * the dotted name the code tool shows (`sterling.knowledge_create`) does not bite.
 */
export function storeWriteTools(pluginRoot = sterlingRootFrom()) {
  const fm = normalize(readFileSync(join(pluginRoot, 'agent-templates', 'implementor.md'), 'utf8')).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const list = fm.match(/^disallowedTools:\s*(.+)$/m)?.[1] ?? '';
  const tools = [...new Set(list.split(',').map((t) => t.trim().match(/^mcp__sterling__(\w+)$/)?.[1]).filter(Boolean))].map((t) => `sterling_${t}`);
  if (!tools.length) throw new Error(`opencode roster: no mcp__sterling__* entries in ${fwd(join(pluginRoot, 'agent-templates', 'implementor.md'))} disallowedTools (P5)`);
  return tools;
}

/**
 * The OpenCode model for a config.models Claude model id: OpenCode names a model
 * provider/model, and Claude models come from its `anthropic` provider.
 */
export function opencodeModelRef(model) {
  if (typeof model !== 'string' || !model) throw new TypeError(`opencodeModelRef: model must be a non-empty string, got ${JSON.stringify(model)}`);
  return `anthropic/${model}`;
}

/** The Sterling plugin root above a module: the nearest directory holding agent-templates/registry.json. */
export function sterlingRootFrom(moduleUrl = import.meta.url) {
  const start = dirname(fileURLToPath(moduleUrl));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'agent-templates', 'registry.json'))) return dir;
    if (dirname(dir) === dir) throw new Error(`no Sterling plugin root (agent-templates/registry.json) at or above ${start}`);
  }
}

/**
 * The Sterling-full render: the template's OpenCode-host text with Sterling lines
 * kept, OpenCode frontmatter, the role's permissions (store-write tools denied to
 * every role that may not write the store), and the OpenCode model when one is pinned.
 */
export function renderFullOpenCodeAgent(templateContent, label, entry, { primary = false, model, writeTools } = {}) {
  const hostText = renderOpenCodeFullText(templateContent, label);
  const permission = FULL_PERMISSIONS[entry.name] ?? entry.opencode?.permission;
  const out = renderOpenCodeAgent(hostText, label, { permission, description: primary ? CONDUCTOR_OPENCODE_DESCRIPTION : undefined });
  const header = parseOpenCodeHeader(out.content);
  let content = normalize(out.content).replace(`${header.headerLine}\n`, '');
  if (primary) content = content.replace(/^mode: subagent$/m, 'mode: primary');
  if (!STORE_WRITERS.has(entry.name)) {
    const denies = (writeTools ?? storeWriteTools()).map((t) => `  ${t}: deny`);
    const close = content.indexOf('\n---\n', 4);
    const block = /^permission:$/m.test(content.slice(0, close)) ? denies : ['permission:', ...denies];
    content = `${content.slice(0, close)}\n${block.join('\n')}${content.slice(close)}`;
  }
  if (model) content = content.replace(/^(mode: \w+)$/m, `$1\nmodel: ${model}`);
  const fmEnd = content.indexOf('\n---\n', 4) + 5;
  const fullHeader = `<!-- sterling-full renderer=opencode-full/1 template=${out.name} template_hash=${sha256(templateContent)} content_hash=${sha256(content)} -->`;
  return { name: out.name, content: `${content.slice(0, fmEnd)}${fullHeader}\n${content.slice(fmEnd)}` };
}

/** The `model:` line of a Sterling-full file's frontmatter, or undefined. */
function frontmatterModel(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  return fm?.[1].match(/^model: (\S+)$/m)?.[1];
}

/**
 * Render and write the Sterling-full conductor and roster. `models` maps a roster
 * name to the OpenCode model to pin (the System-tab swap); an agent not in it keeps
 * the model its installed, unedited file already pins, so a sync never reverts a swap.
 */
export function ensureFullAgents({ projectDir, pluginRoot, tracked, models = {} }) {
  const registry = loadRegistry(join(pluginRoot, 'agent-templates', 'registry.json'));
  const writeTools = storeWriteTools(pluginRoot);
  const rows = [];
  for (const name of ROSTER) {
    const entry = registry.agents.find((a) => a.name === name);
    if (!entry) throw new Error(`opencode roster: '${name}' is not in agent-templates/registry.json (P5)`);
    const rel = `${STERLING_AGENTS_SUBDIR}/${name}.md`;
    const path = join(projectDir, rel);
    if (tracked.includes(rel)) {
      rows.push(refusal(rel, `${rel} is tracked by git, and the Sterling-full agents are per-user`, `untrack it (git rm --cached ${rel} and commit), then rerun /sterling:update`));
      continue;
    }
    const disk = existsSync(path) ? normalize(readFileSync(path, 'utf8')) : null;
    if (disk !== null) {
      const m = disk.match(FULL_HEADER_RE);
      if (!m || m[1] !== name) {
        rows.push(refusal(rel, `${rel} carries no Sterling header (a file Sterling did not write)`, `rename or remove it, then rerun /sterling:update`));
        continue;
      }
      if (sha256(disk.replace(`${m[0]}\n`, '')) !== m[3]) {
        rows.push(refusal(rel, `${rel} was edited after Sterling wrote it`, `move your edits elsewhere and delete it so Sterling can regenerate it, then rerun /sterling:update`));
        continue;
      }
    }
    const model = models[name] ?? (disk === null ? undefined : frontmatterModel(disk));
    const agent = renderFullOpenCodeAgent(readFileSync(join(pluginRoot, 'agent-templates', entry.file), 'utf8'), entry.file, entry, { primary: name === 'conductor', model, writeTools });
    if (agent.name !== name) throw new Error(`opencode roster: '${entry.file}' renders as '${agent.name}', not '${name}' (P5)`);
    if (disk === agent.content) {
      rows.push({ item: rel, status: 'matches' });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, agent.content);
    rows.push({ item: rel, status: disk === null ? 'created' : 'refreshed' });
  }
  return rows;
}

/**
 * The System-tab model swap on OpenCode: re-render the project's Sterling-full set,
 * pinning the OpenCode model for `model` on every swapped roster agent. A project
 * whose Sterling-full set was never installed is skipped; nothing is created.
 */
export function swapFullAgentModel({ projectDir, pluginRoot, agents, model }) {
  if (!existsSync(join(projectDir, STERLING_AGENTS_SUBDIR))) return { skipped: `no Sterling-full OpenCode agents in ${STERLING_AGENTS_SUBDIR}` };
  const ref = opencodeModelRef(model);
  const models = Object.fromEntries(agents.filter((a) => ROSTER.includes(a)).map((a) => [a, ref]));
  const ls = git(projectDir, ['ls-files', '--', '.opencode']);
  const tracked = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
  return { rows: ensureFullAgents({ projectDir, pluginRoot, tracked, models }) };
}

/**
 * Steps 1-3 for one project. Returns { skipped } when OpenCode is absent or not 2.x,
 * else { rows } — every row { item, status, detail?, refused?, instruction? }, with
 * status created | matches | refreshed | skipped | refused.
 */
export function setupOpenCode({ projectDir, pluginRoot, env = process.env, home = homedir(), installed, probe = probeOpenCode }) {
  if (!isAbsolute(projectDir)) throw new TypeError(`setupOpenCode: projectDir must be absolute, got ${projectDir}`);
  // The test preload sets this so a test run never touches the real ~/.config/opencode.
  if (env.STERLING_OPENCODE_SETUP_DISABLE === '1') return { skipped: 'Sterling on OpenCode SKIPPED (STERLING_OPENCODE_SETUP_DISABLE=1)' };
  const oc = probe({ env });
  if (!oc.installed) return { skipped: `OpenCode not installed (${oc.reason}) — Sterling on OpenCode SKIPPED; install OpenCode 2, then run /sterling:update` };
  if (oc.major < 2) return { skipped: `OpenCode ${oc.version} found, but Sterling on OpenCode needs 2.x — SKIPPED; upgrade OpenCode (opencode upgrade), then run /sterling:update` };
  const isInstalled = installed ?? isInstalledCopy(pluginRoot, { env, home });
  const rows = installGlobal({ pluginRoot, installed: isInstalled, env, home });
  rows.push(ensureCodexServer({ env, home }));
  const ls = git(projectDir, ['ls-files', '--', '.opencode']);
  const tracked = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
  let mode;
  try {
    mode = readProjectMode(projectDir);
  } catch (err) {
    // Unknown mode: exclude only Sterling's own paths, the choice that can never hide
    // committed portable agents. Said, not silent.
    mode = null;
    rows.push({ item: '.sterling/config.json mode', status: 'skipped', detail: `${err.message} — excluding only Sterling's own .opencode paths` });
  }
  rows.push(ensureExcluded({ projectDir, mode, tracked }));
  // The agents render first so default_agent is set only when the conductor file is Sterling's.
  const agentRows = ensureFullAgents({ projectDir, pluginRoot, tracked });
  const conductorRow = agentRows.find((r) => r.item === `${STERLING_AGENTS_SUBDIR}/conductor.md`);
  const conductorOk = ['created', 'matches', 'refreshed'].includes(conductorRow?.status);
  rows.push(ensureProjectConfig({ projectDir, home, tracked, conductorOk }));
  rows.push(...agentRows);
  return { rows };
}

/** One printable line per row, prefixed so /sterling:update's agent-status parser skips it. */
export function formatOpenCodeRows(result) {
  if (result.skipped) return [`OpenCode: ${result.skipped}`];
  return result.rows.map((r) => `OpenCode ${r.status}: ${r.item}${r.detail ? ` — ${r.detail}` : ''}`);
}
