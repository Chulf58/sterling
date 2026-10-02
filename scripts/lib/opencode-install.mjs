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
//    sterling-mcp.mjs, the MCP launcher. All three resolve the Sterling root at RUN
//    time: the authoring clone's path is baked (a clone does not move on update), an
//    installed copy is the newest one the shared resolver (scripts/lib/sterling-roots.mjs)
//    finds in Claude Code's plugin cache or OpenCode's npm cache, so no versioned install
//    path is ever written to disk. A file of the same name that Sterling did not write,
//    or one edited since, is refused, never overwritten. When the Sterling in use is the
//    npm package from `opencode plugin add`, no server shim is installed, because
//    `plugin add` registers the server and a shim would load it twice; one an earlier
//    init wrote is removed when its stamp verifies and kept with a KEPT row otherwise.
//    That copy's dashboard is copied to <home>/.sterling/opencode/tui/<version>/
//    (materializeTui), because OpenCode gives a TUI bundle its own solid-js only outside
//    node_modules (finding 789147ca), and the TUI shim loads the newest copy there.
//    Also once per machine: a `codex` entry under mcp.servers in <config dir>/opencode.json,
//    written only for a Codex whose `mcp-server --help` prints mcp-server help.
// 2. PER PROJECT: <project>/.opencode/opencode.json gets the store-guard edit and shell deny rules
//    and default_agent, merged into whatever else the file holds. It gets no `sterling`
//    MCP entry: the server plugin adds that itself (decision
//    sterling-opencode-plugin-injects-its-own-mcp-entry), and an entry an earlier init
//    wrote is removed when it is exactly Sterling's. What Sterling writes under .opencode/ is kept out of git through a
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstalledCopy } from './installed-copy.mjs';
import { RESOLVER_SOURCE as STERLING_RESOLVER_SOURCE, installHostOf, readCopyVersion, compareSterlingVersions } from './sterling-roots.mjs';
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
/** The npm package `opencode plugin add` installs (decision sterling-on-opencode-distributes-as-npm-package-via-opencode-plugin-add). */
export const STERLING_NPM_PACKAGE = '@chulf58/sterling';
export const STORE_GUARD_PATTERNS =['**/.sterling/sterling.db*', '.sterling/sterling.db*'];
export const SHELL_STORE_GUARD_PATTERN = '*sterling.db*';
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

/** materializedRoot: load the newest <materializedRoot>/<version>/ (the npm copy's dashboard, copied outside node_modules) instead of <root>/opencode/sterling-tui. */
export function renderTuiShim(pluginRoot, installed, shimDir, { materializedRoot } = {}) {
  const pkgDirExpr = materializedRoot ? 'newestMaterializedTui()' : `join(${rootExpr(pluginRoot, installed)}, 'opencode', 'sterling-tui')`;
  const materialized = materializedRoot
    ? `
// The npm-installed Sterling's dashboard, copied out of the npm cache because OpenCode
// gives a TUI bundle its own solid-js only outside node_modules (finding 789147ca).
// The newest copied version is taken when this loads, so an update needs no new shim.
function newestMaterializedTui() {
  const base = ${JSON.stringify(fwd(materializedRoot))};
  const versions = sterlingRootsLs(base).filter((n) => /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(n));
  if (!versions.length) throw new Error('Sterling: no dashboard has been copied to ' + base + ' — rerun /sterling:update (or /sterling:init) so Sterling copies it out of the npm cache.');
  versions.sort(compareSterlingVersions);
  return join(base, versions[versions.length - 1]);
}
`
    : '';
  return stampBody(`// Sterling OpenCode TUI shim — generated by /sterling:init and /sterling:update; do not edit.
${IMPORTS}
${RESOLVER_SOURCE}${materialized}
async function loadSterlingTui() {
  const pkgDir = ${pkgDirExpr};
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('Sterling: ' + pkgPath + ' is missing — this Sterling has no OpenCode TUI plugin; update Sterling, then run /sterling:update.');
  }
  const exp = (JSON.parse(readFileSync(pkgPath, 'utf8')).exports || {})['./tui'];
  const rel = typeof exp === 'string' ? exp : exp && (exp.import || exp.default);
  if (typeof rel !== 'string') throw new Error('Sterling: ' + pkgPath + " has no exports['./tui'].");
  const file = join(pkgDir, rel);
  try {
    return (await import(pathToFileURL(file).href)).default;
  } catch (err) {
    const failed = new Error('Sterling: importing the dashboard ' + file + ' failed: ' + String((err && err.message) || err), { cause: err });
    failed.name = IMPORT_FAILED;
    throw failed;
  }
}
const IMPORT_FAILED = 'SterlingDashboardImportError';

// The nearest .sterling/sterling.db at or above dir decides whether this is a Sterling project.
function inSterlingProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.sterling', 'sterling.db'))) return true;
    if (dirname(d) === d) return false;
  }
}

// A missing or broken Sterling must not break OpenCode at import: the failure is kept.
// From setup, a missing Sterling logs one line; a dashboard that fails to import is
// thrown in a Sterling project, naming the file and the cause.
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
    if (loadError && loadError.name !== IMPORT_FAILED) {
      const err = loadError;
      ${notFoundLine('the dashboard', shimDir)}
      return () => {};
    }
    // Non-Sterling projects get no slot, command or route.
    const dir = (api && api.location && api.location.directory) || process.cwd();
    if (!inSterlingProject(dir)) return () => {};
    // A Sterling that was found but whose dashboard does not import is thrown, not logged:
    // a logged line is invisible in the TUI (finding 789147ca saw it swallowed).
    if (loadError) {
      throw new Error(String((loadError && loadError.message) || loadError) + ' — the Sterling dashboard is off. Fix the cause above, or remove ' + ${JSON.stringify(fwd(shimDir))} + '.', { cause: loadError });
    }
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

const TWICE = 'the npm package is registered too, so Sterling would load twice; remove it unless you mean it to';

// Npm copy: `opencode plugin add` registers the server, so the global server shim
// would load it a second time. One an earlier init wrote and nobody edited (its stamp
// verifies) is removed; anything else is kept, loudly.
function retireServerShim(path) {
  const item = fwd(path);
  if (!existsSync(path)) return { item, status: 'skipped', detail: `not installed: opencode plugin add registers the ${STERLING_NPM_PACKAGE} server itself, so a shim would load it twice` };
  if (!statSync(path).isFile()) return { item, status: 'skipped', detail: `KEPT: ${item} is not a file, so it stays; ${TWICE}` };
  const stamp = verifyStamp(normalize(readFileSync(path, 'utf8')), '//');
  if (stamp === null) return { item, status: 'skipped', detail: `KEPT: ${item} exists and Sterling did not write it, so it stays; if it loads Sterling, ${TWICE}` };
  if (!stamp.unmodified) return { item, status: 'skipped', detail: `KEPT: ${item} was edited after Sterling wrote it, so it stays; ${TWICE}` };
  unlinkSync(path);
  return { item, status: 'removed', detail: `the server shim an earlier init wrote: opencode plugin add registers the ${STERLING_NPM_PACKAGE} server, so the shim would load it twice` };
}

// ---------- materialized TUI (npm copy) --------------------------------------
// Finding 789147ca: OpenCode gives a TUI bundle the host's solid-js only when the bundle
// lives outside any node_modules path; imported from the npm cache it fails ('Cannot find
// package @opentui/solid'). So the npm copy's dashboard files are copied to
// <home>/.sterling/opencode/tui/<version>/ and the TUI shim loads the newest version
// there at load time. A marker file lists the hashes Sterling wrote, which is how an
// old version is known to be Sterling's and unedited before it is removed.

export const TUI_MATERIALIZED_FILES = ['package.json', 'sterling-tui.bundle.tsx'];
export const TUI_MATERIALIZED_KEEP = 2;
const MATERIALIZED_MARKER = '.sterling-materialized.json';
const SEMVER_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Raw bytes, no line-ending normalization: the marker records exactly what was copied.
const bytesHash = (b) => createHash('sha256').update(b).digest('hex');

/** <home>/.sterling/opencode/tui — one directory per materialized version. */
export function materializedTuiRoot({ home = homedir() } = {}) {
  return join(home, '.sterling', 'opencode', 'tui');
}

// 'ours' (marker present, only Sterling's files, every hash matches), 'edited', or 'foreign'.
function materializedState(dir) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(join(dir, MATERIALIZED_MARKER), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return 'foreign';
    throw err;
  }
  const files = marker && typeof marker.files === 'object' ? marker.files : null;
  if (!files) return 'foreign';
  const extra = readdirSync(dir).filter((n) => n !== MATERIALIZED_MARKER && !(n in files));
  if (extra.length) return 'edited';
  for (const [name, hash] of Object.entries(files)) {
    if (!existsSync(join(dir, name)) || bytesHash(readFileSync(join(dir, name))) !== hash) return 'edited';
  }
  return 'ours';
}

/**
 * Copies the npm copy's TUI bundle files (TUI_MATERIALIZED_FILES from
 * <pluginRoot>/opencode/sterling-tui/) to <home>/.sterling/opencode/tui/<version>/,
 * then keeps the newest TUI_MATERIALIZED_KEEP versions (and always this one) and
 * removes older versions Sterling wrote and nobody edited. Returns rows; called by
 * setupOpenCode for the npm copy and, after `opencode plugin update`, by the post-update sync.
 */
export function materializeTui({ pluginRoot, env = process.env, home = homedir() }) {
  void env;
  const base = materializedTuiRoot({ home });
  const src = join(pluginRoot, 'opencode', 'sterling-tui');
  const v = readCopyVersion(pluginRoot, 'opencode');
  if (!v.version) return [refusal(`${fwd(base)}/`, `the version of ${fwd(pluginRoot)} cannot be read: ${v.reason}`, 'reinstall Sterling (opencode plugin add @chulf58/sterling), then rerun /sterling:update')];
  const missing = TUI_MATERIALIZED_FILES.filter((f) => !existsSync(join(src, f)));
  if (missing.length) return [refusal(`${fwd(base)}/`, `${fwd(src)} lacks ${missing.join(', ')}, so there is no dashboard to copy`, 'update Sterling, then rerun /sterling:update')];
  const rows = [];
  const dest = join(base, v.version);
  const item = `${fwd(dest)}/`;
  const content = Object.fromEntries(TUI_MATERIALIZED_FILES.map((f) => [f, readFileSync(join(src, f))]));
  const hashes = Object.fromEntries(Object.entries(content).map(([f, b]) => [f, bytesHash(b)]));
  const write = () => {
    mkdirSync(dest, { recursive: true });
    for (const [f, b] of Object.entries(content)) writeFileSync(join(dest, f), b);
    writeFileSync(join(dest, MATERIALIZED_MARKER), `${JSON.stringify({ version: v.version, files: hashes }, null, 2)}\n`);
  };
  if (!existsSync(dest)) {
    write();
    rows.push({ item, status: 'created', detail: `the dashboard copied out of the npm cache (OpenCode gives its own solid-js only outside node_modules)` });
  } else {
    const state = statSync(dest).isDirectory() ? materializedState(dest) : 'foreign';
    if (state === 'foreign') rows.push(refusal(item, `${item} exists and Sterling did not write it`, `move it aside, then rerun /sterling:update`));
    else if (state === 'edited') rows.push(refusal(item, `${item} was edited after Sterling wrote it`, `delete it so Sterling can copy the dashboard again, then rerun /sterling:update`));
    else if (TUI_MATERIALIZED_FILES.every((f) => bytesHash(readFileSync(join(dest, f))) === hashes[f])) rows.push({ item, status: 'matches' });
    else {
      write();
      rows.push({ item, status: 'refreshed' });
    }
  }
  const versions = readdirSync(base).filter((n) => SEMVER_DIR.test(n) && statSync(join(base, n)).isDirectory());
  versions.sort((a, b) => compareSterlingVersions(b, a));
  const keep = new Set([...versions.slice(0, TUI_MATERIALIZED_KEEP), v.version]);
  for (const old of versions.filter((n) => !keep.has(n))) {
    const dir = join(base, old);
    const oldItem = `${fwd(dir)}/`;
    const state = materializedState(dir);
    if (state === 'ours') {
      rmSync(dir, { recursive: true });
      rows.push({ item: oldItem, status: 'removed', detail: `older than the newest ${TUI_MATERIALIZED_KEEP} materialized dashboards` });
    } else {
      rows.push({ item: oldItem, status: 'skipped', detail: `KEPT: ${oldItem} ${state === 'foreign' ? 'was not written by Sterling' : 'was edited after Sterling wrote it'}, so it stays although it is older than the newest ${TUI_MATERIALIZED_KEEP}` });
    }
  }
  return rows;
}

// The TUI shim directory: a package.json exporting './tui' to the stamped tui.tsx.
function ensureTuiShim(tuiDir, shim) {
  const pkgPath = join(tuiDir, 'package.json');
  const pkgLabel = `${fwd(tuiDir)}/package.json`;
  const pkg = renderTuiPackageJson();
  const pkgState = existsSync(pkgPath) && statSync(pkgPath).isFile() ? tuiPackageState(normalize(readFileSync(pkgPath, 'utf8'))) : null;
  if (existsSync(tuiDir) && !statSync(tuiDir).isDirectory()) {
    return [refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)} exists and is not a directory`, 'move it aside, then rerun /sterling:update')];
  }
  if (pkgState === 'foreign') {
    return [refusal(pkgLabel, `${fwd(tuiDir)}/ holds a package.json Sterling did not write`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`)];
  }
  if (pkgState === 'edited') {
    return [refusal(pkgLabel, `${fwd(pkgPath)} was edited after Sterling wrote it`, `delete it so Sterling can regenerate it, then rerun /sterling:update`)];
  }
  if (existsSync(tuiDir) && !existsSync(pkgPath) && readdirSync(tuiDir).length > 0) {
    return [refusal(`${fwd(tuiDir)}/`, `${fwd(tuiDir)}/ exists with files Sterling did not write and no package.json`, `rename or remove ${fwd(tuiDir)}/, then rerun /sterling:update`)];
  }
  const before = existsSync(pkgPath) ? normalize(readFileSync(pkgPath, 'utf8')) : null;
  mkdirSync(tuiDir, { recursive: true });
  if (before !== pkg) writeFileSync(pkgPath, pkg);
  return [
    { item: pkgLabel, status: before === null ? 'created' : before === pkg ? 'matches' : 'refreshed' },
    ensureStampedFile(join(tuiDir, 'tui.tsx'), shim, `${fwd(tuiDir)}/tui.tsx`),
  ];
}

/** npmCopy: the Sterling in use is the `opencode plugin add` package. It registers its own server, so no server shim is installed (an unedited old one is removed), and its dashboard is materialized outside node_modules for the TUI shim to load. */
export function installGlobal({ pluginRoot, installed, npmCopy = false, env = process.env, home = homedir() }) {
  const pluginsDir = join(opencodeConfigDir({ env, home }), 'plugins');
  const tuiDir = join(pluginsDir, 'sterling-tui');
  const rows = [];
  if (npmCopy) {
    rows.push(retireServerShim(join(pluginsDir, 'sterling.js')));
    rows.push(...materializeTui({ pluginRoot, env, home }));
    rows.push(...ensureTuiShim(tuiDir, renderTuiShim(pluginRoot, installed, tuiDir, { materializedRoot: materializedTuiRoot({ home }) })));
  } else {
    rows.push(ensureStampedFile(join(pluginsDir, 'sterling.js'), renderServerShim(pluginRoot, installed, join(pluginsDir, 'sterling.js')), `${fwd(pluginsDir)}/sterling.js`));
    rows.push(...ensureTuiShim(tuiDir, renderTuiShim(pluginRoot, installed, tuiDir)));
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

/**
 * Merge Sterling's keys (store guard, default_agent) into .opencode/opencode.json without
 * touching any other key. Returns one row, or two when an mcp.sterling entry Sterling did
 * not write is kept. No mcp.sterling entry is written any more: the Sterling server plugin
 * adds it (decision sterling-opencode-plugin-injects-its-own-mcp-entry). An entry an
 * earlier init wrote is removed only when it is exactly the entry Sterling wrote.
 */
export function ensureProjectConfig({ projectDir, home = homedir(), tracked, conductorOk = true }) {
  const rel = PROJECT_CONFIG_REL;
  const path = join(projectDir, rel);
  if (tracked.includes(rel)) {
    return [refusal(rel, `${rel} is tracked by git, and Sterling writes .opencode/ config only into untracked files (decision sterling-on-opencode-installs-global-plugins-plus-untracked-project-config)`, `untrack it (git rm --cached ${rel} and commit), then rerun /sterling:update`)];
  }
  let config = {};
  let before = null;
  if (existsSync(path)) {
    before = normalize(readFileSync(path, 'utf8'));
    try {
      config = JSON.parse(before);
    } catch (err) {
      return [refusal(rel, `${rel} is not valid JSON (${err.message})`, `fix or remove ${rel}, then rerun /sterling:update`)];
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return [refusal(rel, `${rel} is not a JSON object`, `fix or remove ${rel}, then rerun /sterling:update`)];
    }
  }
  const notes = [];
  const extraRows = [];
  const mcp = config.mcp ?? {};
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return [refusal(rel, `${rel}: "mcp" is not an object`, `fix ${rel}, then rerun /sterling:update`)];
  if (mcp.sterling !== undefined) {
    const written = { type: 'local', command: mcpCommand({ home }) };
    if (JSON.stringify(mcp.sterling) === JSON.stringify(written)) {
      const { sterling, ...rest } = mcp;
      if (Object.keys(rest).length) config.mcp = rest;
      else delete config.mcp;
      notes.push('removed the sterling MCP entry an earlier init wrote (the Sterling plugin now adds it)');
    } else {
      extraRows.push({ item: `${rel} mcp.sterling`, status: 'skipped', detail: `KEPT: ${rel} has an mcp.sterling entry that differs from the entry Sterling wrote, so it is yours and stays; the Sterling plugin now adds its own sterling MCP entry, so remove yours unless you mean it to replace Sterling's` });
    }
  }
  // Store guard. A string value ("allow"/"ask") becomes the "*" rule so its meaning is
  // kept; Sterling's deny rules are re-added LAST so they win over any broader rule.
  const permission = config.permission ?? {};
  if (typeof permission !== 'object' || Array.isArray(permission)) return [refusal(rel, `${rel}: "permission" is not an object`, `fix ${rel}, then rerun /sterling:update`)];
  // The shape measured live on 2.0.21 (finding 25892d42): "*": "allow" first, then the
  // deny rules. An existing "*" (or a bare string, which becomes "*") is kept as is.
  let edit = permission.edit ?? { '*': 'allow' };
  if (typeof edit === 'string') edit = { '*': edit };
  if (typeof edit !== 'object' || Array.isArray(edit)) return [refusal(rel, `${rel}: "permission.edit" is neither a string nor an object`, `fix ${rel}, then rerun /sterling:update`)];
  const guarded = { '*': 'allow', ...Object.fromEntries(Object.entries(edit).filter(([k]) => !STORE_GUARD_PATTERNS.includes(k))) };
  for (const p of STORE_GUARD_PATTERNS) guarded[p] = 'deny';
  // The edit deny does not cover the shell tool: `printf >> .sterling/sterling.db`
  // got through until this shell rule was added (finding
  // opencode-2-0-21-tool-shapes-execpath-and-shell-store-guard-october-2026). Same merge as edit.
  let shell = permission.shell ?? { '*': 'allow' };
  if (typeof shell === 'string') shell = { '*': shell };
  if (typeof shell !== 'object' || shell === null || Array.isArray(shell)) return [refusal(rel, `${rel}: "permission.shell" is neither a string nor an object`, `fix ${rel}, then rerun /sterling:update`)];
  const shellGuarded = { '*': 'allow', ...Object.fromEntries(Object.entries(shell).filter(([k]) => k !== SHELL_STORE_GUARD_PATTERN)) };
  shellGuarded[SHELL_STORE_GUARD_PATTERN] = 'deny';
  config.permission = { ...permission, edit: guarded, shell: shellGuarded };
  if (!conductorOk) {
    if (config.default_agent === undefined) notes.push(`default_agent not set: the ${CONDUCTOR_AGENT} agent file was refused`);
  } else if (config.default_agent === undefined) config.default_agent = CONDUCTOR_AGENT;
  else if (config.default_agent !== CONDUCTOR_AGENT) notes.push(`default_agent kept as ${JSON.stringify(config.default_agent)} (yours), so OpenCode does not start in ${CONDUCTOR_AGENT}`);
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) return [{ item: rel, status: 'matches', detail: notes.join('; ') || undefined }, ...extraRows];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return [{ item: rel, status: before === null ? 'created' : 'refreshed', detail: notes.join('; ') || 'store-guard edit and shell deny, default_agent' }, ...extraRows];
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
 * status created | matches | refreshed | removed | skipped | refused.
 */
export function setupOpenCode({ projectDir, pluginRoot, env = process.env, home = homedir(), installed, probe = probeOpenCode }) {
  if (!isAbsolute(projectDir)) throw new TypeError(`setupOpenCode: projectDir must be absolute, got ${projectDir}`);
  // The test preload sets this so a test run never touches the real ~/.config/opencode.
  if (env.STERLING_OPENCODE_SETUP_DISABLE === '1') return { skipped: 'Sterling on OpenCode SKIPPED (STERLING_OPENCODE_SETUP_DISABLE=1)' };
  const oc = probe({ env });
  if (!oc.installed) return { skipped: `OpenCode not installed (${oc.reason}) — Sterling on OpenCode SKIPPED; install OpenCode 2, then run /sterling:update` };
  if (oc.major < 2) return { skipped: `OpenCode ${oc.version} found, but Sterling on OpenCode needs 2.x — SKIPPED; upgrade OpenCode (opencode upgrade), then run /sterling:update` };
  const isInstalled = installed ?? isInstalledCopy(pluginRoot, { env, home });
  const npmCopy = isInstalled && installHostOf(pluginRoot, { env, home }) === 'opencode';
  const rows = installGlobal({ pluginRoot, installed: isInstalled, npmCopy, env, home });
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
  rows.push(...ensureProjectConfig({ projectDir, home, tracked, conductorOk }));
  rows.push(...agentRows);
  return { rows };
}

/** One printable line per row, prefixed so /sterling:update's agent-status parser skips it. */
export function formatOpenCodeRows(result) {
  if (result.skipped) return [`OpenCode: ${result.skipped}`];
  return result.rows.map((r) => `OpenCode ${r.status}: ${r.item}${r.detail ? ` — ${r.detail}` : ''}`);
}
