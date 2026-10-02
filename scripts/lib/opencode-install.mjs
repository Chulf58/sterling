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
//    does not move on update), an installed copy is found as the highest-version
//    <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/cache/*/sterling/<version>/ directory, so
//    no versioned cache path is ever written to disk. A file of the same name that
//    Sterling did not write, or one edited since, is refused, never overwritten.
// 2. PER PROJECT: <project>/.opencode/opencode.json gets the `sterling` local MCP entry,
//    the store-guard edit-deny rules and default_agent, merged into whatever else the
//    file holds. What Sterling writes under .opencode/ is kept out of git through a
//    managed block in .git/info/exclude (the committed .gitignore is never edited):
//    the whole /.opencode/ in a hobby project with nothing tracked there, otherwise
//    only Sterling's own paths, so a work project's committed portable agents
//    (.opencode/agents/<name>.md) stay committed.
// 3. The Sterling-FULL conductor (mode primary) and roster (implementor, researcher,
//    scout) go to .opencode/agents/sterling/, which OpenCode 2.0.21 loads as
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
import { isInstalledCopy } from './installed-copy.mjs';
import { stampBody, verifyStamp } from './generated-marker.mjs';
import { sha256, loadRegistry } from './agent-distribution.mjs';
import { renderClaudeText } from './agent-fences.mjs';
import { renderOpenCodeAgent, parseOpenCodeHeader } from './opencode-agents.mjs';
import { ignoredPaths } from './git-ignore-check.mjs';
import { readProjectMode } from './handoff-projection.mjs';

export const STERLING_AGENTS_SUBDIR = '.opencode/agents/sterling';
export const PROJECT_CONFIG_REL = '.opencode/opencode.json';
export const CONDUCTOR_AGENT = 'sterling/conductor';
export const ROSTER = ['conductor', 'implementor', 'researcher', 'scout'];
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

// Builtins-only source inlined into every generated file. ENOENT/ENOTDIR mean "no
// such cache level", which is the normal case; any other error is thrown (P5).
const RESOLVER_SOURCE = `
function newestInstalledSterling() {
  const ls = (d) => {
    try { return readdirSync(d); } catch (err) { if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []; throw err; }
  };
  const cache = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'cache');
  const found = [];
  for (const marketplace of ls(cache)) {
    for (const version of ls(join(cache, marketplace, 'sterling'))) {
      const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(.+))?$/.exec(version);
      if (m) found.push({ dir: join(cache, marketplace, 'sterling', version), nums: [+m[1], +m[2], +m[3]], pre: m[4] });
    }
  }
  found.sort((a, b) =>
    a.nums[0] - b.nums[0] || a.nums[1] - b.nums[1] || a.nums[2] - b.nums[2] ||
    (a.pre === b.pre ? 0 : a.pre === undefined ? 1 : b.pre === undefined ? -1 : a.pre < b.pre ? -1 : 1));
  if (!found.length) {
    throw new Error('Sterling: no installed Sterling plugin under ' + cache + ' — install it (claude plugin install sterling@sterling), then run /sterling:update in a Sterling project.');
  }
  return found[found.length - 1].dir;
}
`;

const IMPORTS = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "import { homedir } from 'node:os';",
  "import { join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
].join('\n');

function rootExpr(pluginRoot, installed) {
  return installed ? 'newestInstalledSterling()' : JSON.stringify(fwd(resolve(pluginRoot)));
}

export function renderServerShim(pluginRoot, installed) {
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
    const root = sterlingRoot();
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

export function renderTuiShim(pluginRoot, installed) {
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

export default await loadSterlingTui();
`, '//');
}

export function renderTuiPackageJson() {
  return `${JSON.stringify({ name: 'sterling-tui', private: true, type: 'module', exports: { './tui': './tui.tsx' }, [PACKAGE_MARKER]: 'Sterling OpenCode TUI shim; written by /sterling:init and /sterling:update' }, null, 2)}\n`;
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
  rows.push(ensureStampedFile(join(pluginsDir, 'sterling.js'), renderServerShim(pluginRoot, installed), `${fwd(pluginsDir)}/sterling.js`));
  const tuiDir = join(pluginsDir, 'sterling-tui');
  const pkgPath = join(tuiDir, 'package.json');
  const pkgLabel = `${fwd(tuiDir)}/package.json`;
  const pkg = renderTuiPackageJson();
  if (existsSync(tuiDir) && !statSync(tuiDir).isDirectory()) {
    rows.push(refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)} exists and is not a directory`, 'move it aside, then rerun /sterling:update'));
  } else if (existsSync(pkgPath) && normalize(readFileSync(pkgPath, 'utf8')) !== pkg && !readFileSync(pkgPath, 'utf8').includes(`"${PACKAGE_MARKER}"`)) {
    rows.push(refusal(pkgLabel, `${fwd(tuiDir)}/ holds a package.json Sterling did not write`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`));
  } else if (existsSync(tuiDir) && !existsSync(pkgPath) && readdirSync(tuiDir).length > 0) {
    rows.push(refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)}/ exists with files Sterling did not write and no package.json`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`));
  } else {
    const before = existsSync(pkgPath) ? normalize(readFileSync(pkgPath, 'utf8')) : null;
    mkdirSync(tuiDir, { recursive: true });
    if (before !== pkg) writeFileSync(pkgPath, pkg);
    rows.push({ item: pkgLabel, status: before === null ? 'created' : before === pkg ? 'matches' : 'refreshed' });
    rows.push(ensureStampedFile(join(tuiDir, 'tui.tsx'), renderTuiShim(pluginRoot, installed), `${fwd(tuiDir)}/tui.tsx`));
  }
  rows.push(ensureStampedFile(mcpLauncherPath({ home }), renderMcpLauncher(pluginRoot, installed), fwd(mcpLauncherPath({ home }))));
  return rows;
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
export function ensureProjectConfig({ projectDir, home = homedir(), tracked }) {
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
  if (config.default_agent === undefined) config.default_agent = CONDUCTOR_AGENT;
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

const CONDUCTOR_OPENCODE_NOTE = `
## On OpenCode

On OpenCode this roster is installed as sterling/implementor, sterling/researcher and sterling/scout; dispatch those names. In a work project the bare-named implementor, researcher and scout are the portable copies committed for colleagues without Sterling, so do not dispatch them.
`;

/** The Sterling-full render: Claude body (Sterling lines kept), OpenCode frontmatter. */
export function renderFullOpenCodeAgent(templateContent, label, entry, { primary = false } = {}) {
  const claudeText = renderClaudeText(templateContent, label);
  const out = renderOpenCodeAgent(claudeText, label, { permission: entry.opencode?.permission });
  const header = parseOpenCodeHeader(out.content);
  let content = normalize(out.content).replace(`${header.headerLine}\n`, '');
  if (primary) content = content.replace(/^mode: subagent$/m, 'mode: primary') + CONDUCTOR_OPENCODE_NOTE;
  const fmEnd = content.indexOf('\n---\n', 4) + 5;
  const fullHeader = `<!-- sterling-full renderer=opencode-full/1 template=${out.name} template_hash=${sha256(templateContent)} content_hash=${sha256(content)} -->`;
  return { name: out.name, content: `${content.slice(0, fmEnd)}${fullHeader}\n${content.slice(fmEnd)}` };
}

export function ensureFullAgents({ projectDir, pluginRoot, tracked }) {
  const registry = loadRegistry(join(pluginRoot, 'agent-templates', 'registry.json'));
  const rows = [];
  const rendered = ROSTER.map((name) => {
    const entry = registry.agents.find((a) => a.name === name);
    if (!entry) throw new Error(`opencode roster: '${name}' is not in agent-templates/registry.json (P5)`);
    return renderFullOpenCodeAgent(readFileSync(join(pluginRoot, 'agent-templates', entry.file), 'utf8'), entry.file, entry, { primary: name === 'conductor' });
  });
  for (const agent of rendered) {
    const rel = `${STERLING_AGENTS_SUBDIR}/${agent.name}.md`;
    const path = join(projectDir, rel);
    if (tracked.includes(rel)) {
      rows.push(refusal(rel, `${rel} is tracked by git, and the Sterling-full agents are per-user`, `untrack it (git rm --cached ${rel} and commit), then rerun /sterling:update`));
      continue;
    }
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, agent.content);
      rows.push({ item: rel, status: 'created' });
      continue;
    }
    const disk = normalize(readFileSync(path, 'utf8'));
    if (disk === agent.content) {
      rows.push({ item: rel, status: 'matches' });
      continue;
    }
    const m = disk.match(FULL_HEADER_RE);
    if (!m || m[1] !== agent.name) {
      rows.push(refusal(rel, `${rel} carries no Sterling header (a file Sterling did not write)`, `rename or remove it, then rerun /sterling:update`));
      continue;
    }
    if (sha256(disk.replace(`${m[0]}\n`, '')) !== m[3]) {
      rows.push(refusal(rel, `${rel} was edited after Sterling wrote it`, `move your edits elsewhere and delete it so Sterling can regenerate it, then rerun /sterling:update`));
      continue;
    }
    writeFileSync(path, agent.content);
    rows.push({ item: rel, status: 'refreshed' });
  }
  return rows;
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
  rows.push(ensureProjectConfig({ projectDir, home, tracked }));
  rows.push(...ensureFullAgents({ projectDir, pluginRoot, tracked }));
  return { rows };
}

/** One printable line per row, prefixed so /sterling:update's agent-status parser skips it. */
export function formatOpenCodeRows(result) {
  if (result.skipped) return [`OpenCode: ${result.skipped}`];
  return result.rows.map((r) => `OpenCode ${r.status}: ${r.item}${r.detail ? ` — ${r.detail}` : ''}`);
}
