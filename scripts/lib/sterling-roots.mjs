// The one resolver for installed Sterling copies, on both hosts (board item
// parity-p7-standalone-install-and-update-on-a-machine-with-op, slice S1; decisions
// sterling-on-opencode-distributes-as-npm-package-via-opencode-plugin-add and
// dual-host-post-update-sync-newest-copy-wins). Every caller that looks for an
// installed Sterling uses this module, so the install roots are named here only.
//
// INSTALL ROOTS:
//   claude-code  <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/cache/<marketplace>/sterling/<version>/
//   opencode     <XDG_CACHE_HOME or ~/.cache>/opencode/npm/<key>/<timestamp>/node_modules/@chulf58/sterling/
//                (finding 3b0d9ea0: `opencode plugin add` installs there and every update adds a
//                new timestamp dir; the key is `name@spec`, so the scope may or may not be its
//                own directory level, which is why the walk is depth-bounded instead of fixed.)
// VERSION: read from the copy's own manifest, never from a directory name. A claude-code
//   copy reads .claude-plugin/plugin.json first, an opencode copy package.json first; the
//   other file is the fallback. A copy with neither, or with an unparsable one, is skipped
//   and its reason is reported.
// NEWEST: the highest version by compareSterlingVersions (SemVer 2.0.0 precedence; a
//   pre-release sorts below its release). TIE: the claude-code copy wins over the opencode copy (the long-standing
//   install path); within one host the lexically greater root wins, which for OpenCode
//   is the later timestamp directory.
//
// Generated files (the OpenCode shims, the MCP launcher, sterling-check.mjs, the tmux
// launcher) run outside any Sterling copy and cannot import this module from a
// versioned directory, so they inline RESOLVER_SOURCE. This module builds its own
// functions from that same string, so the inlined copy and the library cannot diverge.
// A string, not Function.prototype.toString: esbuild renames imported identifiers when
// it bundles (join -> join2), which would break source recovered from a bundled function.
//
// Builtins only: hooks bundle this module through installed-copy.mjs.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The import lines a generated file needs before RESOLVER_SOURCE. */
export const RESOLVER_IMPORTS = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "import { homedir } from 'node:os';",
  "import { join } from 'node:path';",
].join('\n');

// No backticks and no dollar-brace in here: it is a String.raw template literal.
export const RESOLVER_SOURCE = String.raw`
function installRoots(env = process.env, home = homedir()) {
  return [
    { host: 'claude-code', dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins', 'cache') },
    { host: 'opencode', dir: join(env.XDG_CACHE_HOME || join(home, '.cache'), 'opencode', 'npm') },
  ];
}

// ENOENT/ENOTDIR mean "no such level", the normal case; any other error is thrown.
function sterlingRootsLs(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}

function readCopyVersion(root, host) {
  const manifests = host === 'opencode' ? ['package.json', '.claude-plugin/plugin.json'] : ['.claude-plugin/plugin.json', 'package.json'];
  for (const rel of manifests) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      throw err;
    }
    let version;
    try {
      version = JSON.parse(text).version;
    } catch (err) {
      return { reason: rel + ' is not valid JSON (' + err.message + ')' };
    }
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) && parseSterlingVersion(version)) return { version };
    return { reason: rel + ' has no semver version (got ' + JSON.stringify(version) + ')' };
  }
  return { reason: 'no .claude-plugin/plugin.json or package.json' };
}

// The one semver order for both hosts (post-update-sync.mjs delegates here): SemVer 2.0.0
// precedence. Strict grammar: major.minor.patch with no leading zeros and no v prefix,
// dot-separated prerelease identifiers, build metadata accepted and ignored. A prerelease
// sorts below its release; prerelease identifiers compare one by one, numeric ones
// numerically and below alphanumeric ones, and a longer list wins when all shared ones match.
function parseSterlingVersion(v) {
  const m = typeof v === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(v) : null;
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function compareSterlingVersions(a, b) {
  const x = parseSterlingVersion(a);
  const y = parseSterlingVersion(b);
  if (!x || !y) throw new Error('compareSterlingVersions: not a semver version: ' + JSON.stringify(x ? b : a));
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function scanInstalledSterling(env = process.env, home = homedir()) {
  const roots = installRoots(env, home);
  const copies = [];
  const skipped = [];
  const consider = (root, host) => {
    const v = readCopyVersion(root, host);
    if (v.version) copies.push({ root, version: v.version, host });
    else skipped.push({ root, host, reason: v.reason });
  };
  for (const { host, dir } of roots) {
    if (host === 'claude-code') {
      for (const marketplace of sterlingRootsLs(dir)) {
        for (const entry of sterlingRootsLs(join(dir, marketplace, 'sterling'))) consider(join(dir, marketplace, 'sterling', entry), host);
      }
      continue;
    }
    const walk = (d, depth) => {
      const pkg = join(d, 'node_modules', '@chulf58', 'sterling');
      if (existsSync(pkg)) consider(pkg, host);
      if (depth === 0) return;
      for (const name of sterlingRootsLs(d)) if (name !== 'node_modules') walk(join(d, name), depth - 1);
    };
    walk(dir, 4);
  }
  return { roots, copies, skipped };
}

function newestInstalledSterling(env = process.env, home = homedir()) {
  let best = null;
  for (const c of scanInstalledSterling(env, home).copies) {
    if (!best) {
      best = c;
      continue;
    }
    const d = compareSterlingVersions(c.version, best.version) ||
      (c.host === best.host ? 0 : c.host === 'claude-code' ? 1 : -1) ||
      (c.root > best.root ? 1 : c.root < best.root ? -1 : 0);
    if (d > 0) best = c;
  }
  return best;
}

// host null: the asking host is unknown, so both commands are named.
function sterlingInstallRemedy(host) {
  if (host === 'claude-code') return 'claude plugin install sterling@sterling';
  if (host === 'opencode') return 'opencode plugin add @chulf58/sterling';
  if (host === null) return 'claude plugin install sterling@sterling for Claude Code, or opencode plugin add @chulf58/sterling for OpenCode';
  throw new Error('sterlingInstallRemedy: unknown host ' + JSON.stringify(host));
}

function sterlingNotFoundMessage(host, env = process.env, home = homedir()) {
  const remedy = sterlingInstallRemedy(host);
  const scan = scanInstalledSterling(env, home);
  const where = scan.roots.map((r) => r.dir + ' (' + r.host + ')').join(' or ');
  const why = scan.skipped.map((s) => '; skipped ' + s.root + ': ' + s.reason).join('');
  return 'no installed Sterling found under ' + where + why + '. Install it: ' + remedy + '.';
}
`;

const api = new Function(
  'existsSync',
  'readFileSync',
  'readdirSync',
  'join',
  'homedir',
  `${RESOLVER_SOURCE}\nreturn { installRoots, readCopyVersion, parseSterlingVersion, compareSterlingVersions, scanInstalledSterling, newestInstalledSterling, sterlingInstallRemedy, sterlingNotFoundMessage };`,
)(existsSync, readFileSync, readdirSync, join, homedir);

/** (env = process.env, home = homedir()) -> [{host: 'claude-code'|'opencode', dir}] */
export const installRoots = api.installRoots;
/** (root, host) -> {version} | {reason} */
export const readCopyVersion = api.readCopyVersion;
/** (v) -> {core: [major, minor, patch], pre: [identifiers]} | null when v is not a semver version (strict grammar, above). */
export const parseSterlingVersion = api.parseSterlingVersion;
/** (a, b) -> -1 | 0 | 1, SemVer 2.0.0 precedence; throws on a non-semver input. */
export const compareSterlingVersions = api.compareSterlingVersions;
/** (env, home) -> {roots, copies: [{root, version, host}], skipped: [{root, host, reason}]} */
export const scanInstalledSterling = api.scanInstalledSterling;
/** (env, home) -> {root, version, host} | null. Reasons for a null: scanInstalledSterling().skipped, or sterlingNotFoundMessage. */
export const newestInstalledSterling = api.newestInstalledSterling;
/** ('claude-code' | 'opencode' | null) -> the install command; throws on any other host. */
export const sterlingInstallRemedy = api.sterlingInstallRemedy;
/** (host, env, home) -> one line: the roots searched, every skipped copy with its reason, the host's install command. */
export const sterlingNotFoundMessage = api.sterlingNotFoundMessage;

/** ('claude-code' | 'opencode' | null) -> how to update an installed copy; throws on any other host. */
export function sterlingUpdateRemedy(host) {
  if (host === 'claude-code') return '/plugin (Installed tab → Update) or `claude plugin update sterling@<marketplace>`';
  if (host === 'opencode') return '`opencode plugin update @chulf58/sterling`';
  if (host === null) return '`claude plugin update sterling@<marketplace>` (Claude Code) or `opencode plugin update @chulf58/sterling` (OpenCode)';
  throw new Error(`sterlingUpdateRemedy: unknown host ${JSON.stringify(host)}`);
}

// realpath when the path exists; a path that does not exist cannot be reached
// through a symlink, so its plain resolved form is its identity.
function canonical(p) {
  try {
    return realpathSync(p);
  } catch (err) {
    if (err?.code === 'ENOENT') return resolve(p);
    throw err;
  }
}

/** The host whose install root `root` resolves (realpath) under, or null when under neither. */
export function installHostOf(root, { env = process.env, home = homedir() } = {}) {
  const real = canonical(root);
  for (const { host, dir } of installRoots(env, home)) {
    if (real.startsWith(canonical(dir) + sep)) return host;
  }
  return null;
}
