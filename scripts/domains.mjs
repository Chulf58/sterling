// /sterling:domains: the map of every knowledge domain this user has on this
// machine and the registered projects that mount it, a proposal of the mounts
// the current project is missing, and --apply to add them (decision
// consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command).
//   node scripts/domains.mjs [--target <dir>]            the map as text
//   node scripts/domains.mjs --json                      the same map as JSON
//   node scripts/domains.mjs --apply --add <domain> [--add <domain> ...]
//                            [--description <domain>=<text> ...]
// Exit 0 on success, 2 on a refusal that names its reason.
//
// The map is computed on each run from two sources and stored nowhere: the
// domain store folders (~/.sterling/domains/<name>/sterling.db, plus the current
// project's config.domain_paths) and the shared project registry
// (~/.sterling/registry.db). Domain stores are opened read-only and never
// changed by the report.
//
// WHAT A RUN WRITES. A report run writes one thing: when the current project is
// initialized but missing from the registry (init is the only other writer of a
// registry row), it registers it, and says so. --apply writes three: a new
// domain store through createDomain (which needs a description), the current
// project's stack_tags in .sterling/config.json, and its registry row. It never
// removes a tag, never moves a record and never writes to another project.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig, sameLocationAnyHost } from '@sterling/schemas';
import { ProjectRegistry, registryPath, createDomain, resolveDomainMounts, DOMAIN_DESCRIPTION_KEY, SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { resolveLinkedWorktree } from './lib/project.mjs';
import { resolveStoreWritePath } from './lib/store-path.mjs';
import { DEFAULT_DOMAIN_DESCRIPTIONS } from './lib/domain-defaults.mjs';
import { buildDomainMap, renderDomainMap, UNIVERSAL_DOMAIN } from './lib/domain-map.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => p.replace(/\\/g, '/');
const USAGE = 'usage: domains.mjs [--target <dir>] [--json] | --apply --add <domain> [--add <domain> ...] [--description <domain>=<text> ...]';

function refuse(reason) {
  console.error(`domains REFUSED: ${reason}`);
  process.exit(2);
}

// ---- arguments, parsed strictly: an unknown flag refuses instead of being ignored ----
const opts = { json: false, apply: false, add: [], descriptions: new Map(), target: undefined };
{
  const argv = process.argv.slice(2);
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) refuse(`${flag} needs a value. ${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--apply') opts.apply = true;
    else if (a === '--add') opts.add.push(value(i++, a));
    else if (a === '--target') opts.target = value(i++, a);
    else if (a === '--description') {
      const v = value(i++, a);
      const eq = v.indexOf('=');
      const name = eq > 0 ? v.slice(0, eq).trim() : '';
      const text = eq > 0 ? v.slice(eq + 1).trim() : '';
      if (!name || !text) refuse(`--description takes <domain>=<text>, the text saying which knowledge belongs in the domain (got '${v}')`);
      opts.descriptions.set(name, text);
    } else refuse(`unrecognized argument '${a}'. ${USAGE}`);
  }
}
if (opts.add.length && !opts.apply) refuse('--add changes the project only together with --apply; without --apply the command only reports');
if (opts.descriptions.size && !opts.apply) refuse('--description is used only together with --apply --add <domain>');
if (opts.apply && !opts.add.length) refuse('--apply needs at least one --add <domain>');
if (opts.apply && opts.json) refuse('--json prints the map; it cannot be combined with --apply');

// ---- the current project ----
// A linked git worktree has no .sterling/ of its own (it is gitignored), so the
// project is the main checkout.
const startDir = resolve(opts.target ?? process.cwd());
const projectDir = resolveLinkedWorktree(startDir)?.mainRoot ?? startDir;

function readProject(dir) {
  const configPath = resolveStoreWritePath(dir, '.sterling', 'config.json');
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, 'utf8');
  const raw = JSON.parse(text);
  return { dir, configPath, text, raw, config: parseConfig(raw) };
}

let project;
try {
  project = readProject(projectDir);
} catch (e) {
  refuse(`${fwd(projectDir)}/.sterling/config.json could not be read as a Sterling config (${e.message}). Repair it first; nothing was written.`);
}

// ---- domain stores, read-only ----
const domainsRoot = join(homedir(), '.sterling', 'domains');

function inspectStore(name, dbPath) {
  const entry = { name, path: fwd(dbPath), description: null, format: 'current', unreadable: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    // The store's own rule (packages/store/src/index.ts): an existing, non-empty
    // store below the supported schema version is a legacy store.
    if (tables.length && version < SUPPORTED_SCHEMA_VERSION) entry.format = 'old';
    else if (tables.includes('store_meta')) {
      entry.description = db.prepare('SELECT value FROM store_meta WHERE key = ?').get(DOMAIN_DESCRIPTION_KEY)?.value?.trim() || null;
    }
  } catch (e) {
    entry.unreadable = String(e?.message ?? e);
  } finally {
    db?.close();
  }
  return entry;
}

function listStores() {
  const found = new Map();
  if (existsSync(domainsRoot)) {
    for (const d of readdirSync(domainsRoot, { withFileTypes: true })) {
      const dbPath = join(domainsRoot, d.name, 'sterling.db');
      if (d.isDirectory() && existsSync(dbPath)) found.set(d.name, dbPath);
    }
  }
  // The current project's per-domain path overrides name the store it really mounts.
  for (const [name, dbPath] of Object.entries(project?.config.domain_paths ?? {})) {
    if (existsSync(dbPath)) found.set(name, dbPath);
    else found.delete(name);
  }
  return [...found].map(([name, dbPath]) => inspectStore(name, dbPath));
}

// ---- the registry ----
function pluginVersion() {
  try {
    const v = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

function registerCurrent(registry, repoPath, name) {
  registry.register({
    repo_path: repoPath,
    name,
    stack_tags: project.config.stack_tags,
    toolchains: project.config.toolchains.map((t) => t.adapter),
    sterling_version: pluginVersion(),
    at: new Date().toISOString(),
  });
}

const notes = [];
const projectName = project ? (project.config.project_name ?? basename(projectDir)) : null;
let currentPath = fwd(projectDir);
let rows = [];
// The registry file is created only for an initialized project: a report run
// from any other folder reads it when it exists and writes nothing.
if (project || existsSync(registryPath())) {
  const registry = new ProjectRegistry(registryPath());
  try {
    rows = registry.list();
    if (project) {
      const mine = rows.find((p) => sameLocationAnyHost(p.repo_path, currentPath));
      if (mine) currentPath = mine.repo_path;
      else {
        registerCurrent(registry, currentPath, projectName);
        rows = registry.list();
        notes.push(`${projectName} was not in the project registry (it was initialized by a Sterling version from before the registry, or on another machine or user). It is now registered, so other projects' maps list it.`);
      }
    }
  } finally {
    registry.close();
  }
}

// A sibling's tags are read from its config as it is now. The registry holds the
// tags recorded at its last init, which are used only when the config cannot be read.
const projects = rows.map((p) => {
  const exists = existsSync(p.repo_path);
  let stack_tags = p.stack_tags;
  if (exists && p.repo_path !== currentPath) {
    try {
      const sibling = readProject(p.repo_path);
      if (sibling) {
        stack_tags = sibling.config.stack_tags;
        const overrides = Object.keys(sibling.config.domain_paths);
        if (overrides.length) notes.push(`${p.name} sets its own store path for ${overrides.join(', ')}; this map shows the store at the default location.`);
      } else notes.push(`${p.name} has no .sterling/config.json; its mounts are the tags the registry recorded at its last init.`);
    } catch (e) {
      notes.push(`${p.name}: its config could not be read (${e.message}); its mounts are the tags the registry recorded at its last init.`);
    }
  }
  return { name: p.name, path: fwd(p.repo_path), stack_tags, exists };
});
const current = project ? { name: projectName, path: currentPath, stack_tags: project.config.stack_tags } : null;

if (!opts.apply) {
  const map = buildDomainMap({ stores: listStores(), projects, current, notes });
  if (opts.json) console.log(JSON.stringify(map, null, 2));
  else {
    console.log('Knowledge domains on this machine, for this user');
    console.log('');
    console.log(renderDomainMap(map, { applyCommand: `node "${fwd(process.argv[1])}"` }));
  }
  process.exit(0);
}

// ---- --apply: add mounts to the current project, all or nothing ----
if (!project) refuse(`${fwd(projectDir)} is not an initialized Sterling project (no .sterling/config.json). Run /sterling:init there first.`);
for (const name of opts.add) {
  if (!name.trim() || name !== name.trim() || /[\\/]/.test(name) || name === '.' || name === '..') {
    refuse(`'${name}' is not a domain name: a domain name is one folder name under ~/.sterling/domains/, with no slash`);
  }
}
for (const name of opts.descriptions.keys()) {
  if (!opts.add.includes(name)) refuse(`--description names '${name}', which is not one of the --add domains (${opts.add.join(', ')})`);
}

const mounted = project.config.stack_tags;
const wanted = [...new Set(opts.add)];
const toAdd = wanted.filter((name) => !mounted.includes(name));
// Every named domain is planned, a tag the project already lists included: such a
// tag may still name a store that was never created, and this is where it is made.
const plan = resolveDomainMounts({ stack_tags: wanted, domain_paths: project.config.domain_paths }).map((m) => ({
  ...m,
  exists: existsSync(m.dbPath),
  listed: mounted.includes(m.name),
  description: opts.descriptions.get(m.name) ?? DEFAULT_DOMAIN_DESCRIPTIONS[m.name],
}));
const undescribed = plan.filter((m) => !m.exists && !m.description);
if (undescribed.length) {
  refuse(
    `${undescribed.map((m) => `'${m.name}'`).join(', ')} ${undescribed.length === 1 ? 'has' : 'have'} no store yet, and a new domain store is created only with a description of which knowledge belongs in it. Pass ` +
      `${undescribed.map((m) => `--description ${m.name}=<text>`).join(' ')}. Nothing was written.`
  );
}

const done = [];
let created = 0;
for (const m of plan) {
  if (!m.exists) {
    createDomain(m.name, m.description, m.dbPath);
    created++;
    done.push(`created the domain store '${m.name}' at ${fwd(m.dbPath)}: ${m.description}`);
    if (m.listed) done.push(`'${m.name}' was already in stack_tags; it had no store until now`);
  } else {
    const unused = opts.descriptions.has(m.name) ? ' (the --description given for it was not applied)' : '';
    done.push(m.listed ? `'${m.name}' is already mounted; nothing to change for it${unused}` : `'${m.name}' already has a store at ${fwd(m.dbPath)}; its description is unchanged${unused}`);
  }
}

if (toAdd.length) {
  // New tags go ahead of a trailing 'sterling', where init keeps the universal
  // domain so the project's own subjects come first. Every existing tag stays.
  const tags = Array.isArray(project.raw.stack_tags) ? project.raw.stack_tags : mounted;
  const universalLast = tags.at(-1) === UNIVERSAL_DOMAIN;
  const next = universalLast ? [...tags.slice(0, -1), ...toAdd, UNIVERSAL_DOMAIN] : [...tags, ...toAdd];
  const nextRaw = { ...project.raw, stack_tags: next };
  project.config = parseConfig(nextRaw);
  const tmpPath = resolveStoreWritePath(project.dir, '.sterling', `config.json.tmp-${process.pid}`);
  writeFileSync(tmpPath, JSON.stringify(nextRaw, null, 2) + (project.text.endsWith('\n') ? '\n' : ''));
  renameSync(tmpPath, project.configPath);
  done.push(`stack_tags in .sterling/config.json: ${next.join(', ')}`);

  const registry = new ProjectRegistry(registryPath());
  try {
    registerCurrent(registry, currentPath, projectName);
  } finally {
    registry.close();
  }
  done.push('refreshed this project in the project registry');
}

console.log(`Applied to ${projectName} (${currentPath}):`);
for (const line of done) console.log(`  ${line}`);
for (const note of notes) console.log(`Note: ${note}`);
if (toAdd.length || created) {
  console.log('');
  console.log('Restart the session for the new mount to load: the Sterling MCP server mounts domains once, when it starts, so knowledge_query and knowledge_create do not see a new domain until then.');
  if (toAdd.length) console.log('AGENTS.md is not rewritten: update its "Stack tags" and "Domain stores" lines by hand to match.');
}
