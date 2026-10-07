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
// (~/.sterling/registry.db). Domain stores are opened read-only, so a report
// never changes a store's database file (SQLite may create -shm and -wal files
// beside a WAL-mode store while it is read).
//
// POSTGRES STORAGE (issue Chulf58/sterling#26 item 7; decision
// storage-backend-is-its-own-config-key-written-only-by-store-move). When the
// current project's config.storage is 'postgres', its domain stores are the
// sterling_d_<name> rows of the Postgres store registry (<meta>.stores), not the
// folders under ~/.sterling/domains, so the map lists those rows (path
// postgres:<schema>) and reads each store's description with plain SELECTs on
// one short-lived connection. Nothing falls back to the SQLite folders. The
// project registry (~/.sterling/registry.db) and the project's config.json stay
// local either way. --apply on a Postgres-storage project mounts domains whose
// Postgres store exists; it refuses, by name and before writing anything, a
// domain with no Postgres store, because creating one needs createPgStore under
// the global migration lock plus a first open to write the description, and the
// SQLite createDomain below has no Postgres twin here.
//
// WHAT A RUN WRITES. A report run writes one thing: when the current project has
// a config and a project store but no registry row (init is the only other
// writer of a row), it registers it, and says so. --apply writes three: a new
// domain store through createDomain (which needs a description), the current
// project's stack_tags in .sterling/config.json, and the tags of its registry
// row. It never removes a tag, never moves a record and never writes to another
// project: --apply refuses a --target outside the project it runs in.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig, sameLocationAnyHost } from '@sterling/schemas';
import { ProjectRegistry, registryPath, createDomain, resolveDomainMounts, DOMAIN_DESCRIPTION_KEY, SUPPORTED_SCHEMA_VERSION, PgBridge, readPgCredentials, assertSterlingSchemaName } from '@sterling/store';
import { resolveStoreRoute, pgStoreNames } from '@sterling/store/routing';
import { resolveLinkedWorktree } from './lib/project.mjs';
import { resolveStoreWritePath } from './lib/store-path.mjs';
import { DEFAULT_DOMAIN_DESCRIPTIONS } from './lib/domain-defaults.mjs';
import { buildDomainMap, renderDomainMap, UNIVERSAL_DOMAIN } from './lib/domain-map.mjs';

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
const projectRootOf = (dir) => resolveLinkedWorktree(dir)?.mainRoot ?? dir;
const projectDir = projectRootOf(resolve(opts.target ?? process.cwd()));
const hasConfig = (dir) => existsSync(join(dir, '.sterling', 'config.json'));

// The nearest folder at or above `dir` that holds a .sterling/config.json, or null.
function enclosingProject(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (hasConfig(d)) return d;
    if (dirname(d) === d) return null;
  }
}
const real = (p) => (existsSync(p) ? realpathSync(p) : p);

// --apply changes the project the session is working in. With --target it could
// reach any project on the machine, so a target outside that project refuses.
if (opts.apply && opts.target !== undefined) {
  const here = enclosingProject(projectRootOf(process.cwd()));
  if (!here || !sameLocationAnyHost(real(here), real(projectDir))) {
    refuse(`--apply changes only the project the command runs in (${here ? fwd(here) : `${fwd(process.cwd())}, which is in no Sterling project`}), and --target names ${fwd(projectDir)}. Run the command from that project instead. --target is for report runs. Nothing was written.`);
  }
}

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

// The backend the project's stores live on. A route the router refuses (a bad
// storage value, no identity or credentials) refuses
// here too: the SQLite folders are never read in its place.
let route = null;
if (project) {
  try {
    route = resolveStoreRoute(projectDir);
  } catch (e) {
    refuse(`the store settings of ${fwd(projectDir)} cannot be used (${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}). Nothing was written.`);
  }
}
const onPostgres = route?.storage === 'postgres';

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

// The domain stores of a Postgres-storage project: the registry's sterling_d_*
// rows, each with its description read by SELECT on one short-lived connection.
// The connect timeout is capped as the router caps it.
function quotedSchema(schema) {
  assertSterlingSchemaName(schema);
  return `"${schema}"`;
}

function listPostgresStores() {
  let bridge;
  try {
    const config = readPgCredentials(route.credentialsPath);
    bridge = new PgBridge({ ...config, connectionTimeoutMillis: Math.min(config.connectionTimeoutMillis, 2000) });
  } catch (e) {
    refuse(`storage 'postgres': the Postgres store database could not be reached (${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}). Nothing was written, and the domain folders under ~/.sterling/domains were not read in its place.`);
  }
  try {
    // A domain store's schema is <prefix>_d_<name>; the prefix is sterling, or the
    // sterling_test_ namespace a test run points the router at (those rows carry kind 'test').
    const domainPrefix = `${route.testNamespace ?? 'sterling'}_d_`;
    const registered = bridge.query(`SELECT schema_name, name FROM ${quotedSchema(route.metaSchema)}.stores WHERE starts_with(schema_name, $1) ORDER BY name`, [domainPrefix]).rows;
    return registered.map((r) => {
      const schema = String(r.schema_name);
      const entry = { name: String(r.name), schema, path: `postgres:${schema}`, description: null, format: 'current', unreadable: null };
      try {
        const q = `${quotedSchema(schema)}.store_meta`;
        // A store created but never opened has no store_meta table yet: no description.
        if (bridge.query('SELECT to_regclass($1) AS t', [q]).rows[0]?.t) {
          entry.description = String(bridge.query(`SELECT value FROM ${q} WHERE key = $1`, [DOMAIN_DESCRIPTION_KEY]).rows[0]?.value ?? '').trim() || null;
        }
      } catch (e) {
        entry.unreadable = String(e?.message ?? e);
      }
      return entry;
    });
  } catch (e) {
    refuse(`storage 'postgres': the domain stores could not be listed from the Postgres store registry (${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}). Nothing was written.`);
  } finally {
    bridge.close();
  }
}

function listStores() {
  if (onPostgres) return listPostgresStores();
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
const notes = [];
const projectName = project ? (project.config.project_name ?? basename(projectDir)) : null;
const currentPath = fwd(projectDir);
const isCurrent = (row) => Boolean(project) && sameLocationAnyHost(row.repo_path, currentPath);
if (!project) {
  const parent = enclosingProject(dirname(projectDir));
  if (parent) notes.push(`this folder is inside the Sterling project at ${fwd(parent)}. Run the command from there, or pass --target "${fwd(parent)}" for a report on it.`);
}

let rows = [];
let registeredByThisRun = false;
// The registry file is read when it exists. It is created only to register an
// initialized project: a report run from any other folder writes nothing.
// With Postgres storage the project store is its schema, and the router has
// already required its identity file, so the project counts as initialized.
const hasStore = project ? onPostgres || existsSync(join(projectDir, '.sterling', 'sterling.db')) : false;
if (existsSync(registryPath()) || hasStore) {
  const registry = new ProjectRegistry(registryPath());
  try {
    rows = registry.list();
    if (project && !rows.some(isCurrent)) {
      if (hasStore) {
        // register is the only way to make a row. No init ran here, so the row
        // carries no Sterling version; the schema requires both init dates,
        // which are therefore the time of this registration.
        registry.register({
          repo_path: currentPath,
          name: projectName,
          stack_tags: project.config.stack_tags,
          toolchains: project.config.toolchains.map((t) => t.adapter),
          sterling_version: null,
          at: new Date().toISOString(),
        });
        rows = registry.list();
        registeredByThisRun = true;
        notes.push(`${projectName} was not in the project registry (it was initialized by a Sterling version from before the registry, or on another machine or user). It is now registered by this command, so other projects' maps list it; its init dates in /sterling:projects are the time of this registration.`);
      } else {
        notes.push(`${projectName} is not registered: it has no .sterling/sterling.db, so it is not an initialized project. Run /sterling:init here to register it.`);
      }
    }
  } finally {
    registry.close();
  }
}

// Every row's path is forward-slashed before it is compared, checked on disk or
// printed, and the row of the current project takes the current project's path,
// however the registry spelled it. A sibling's tags are read from its config as
// it is now. The registry holds the tags recorded at its last init or mount
// change, which are used only when the config cannot be read.
const projects = rows.map((p) => {
  if (isCurrent(p)) return { name: p.name, path: currentPath, stack_tags: project.config.stack_tags, exists: true };
  const path = fwd(p.repo_path);
  const exists = existsSync(path);
  let stack_tags = p.stack_tags;
  if (exists) {
    try {
      const sibling = readProject(path);
      if (sibling) {
        stack_tags = sibling.config.stack_tags;
        const overrides = Object.keys(sibling.config.domain_paths);
        if (overrides.length) notes.push(`${p.name} sets its own store path for ${overrides.join(', ')}; this map shows the store at the default location.`);
      } else notes.push(`${p.name} has no .sterling/config.json; its mounts are the tags the registry recorded.`);
    } catch (e) {
      notes.push(`${p.name}: its config could not be read (${e.message}); its mounts are the tags the registry recorded.`);
    }
  }
  return { name: p.name, path, stack_tags, exists };
});
const current = project ? { name: projectName, path: currentPath, stack_tags: project.config.stack_tags } : null;

if (onPostgres) notes.push(`${projectName} keeps its stores in Postgres (config.storage), so this map lists the Postgres domain stores, not the domain folders under ~/.sterling/domains.`);

if (!opts.apply) {
  const map = buildDomainMap({ stores: listStores(), projects, current, notes });
  // registered_by_this_run lets a caller that reads the JSON (the update pass, session
  // start) say that the report run wrote a registry row.
  if (opts.json) console.log(JSON.stringify({ ...map, registered_by_this_run: registeredByThisRun }, null, 2));
  else {
    console.log('Knowledge domains on this machine, for this user');
    console.log('');
    console.log(renderDomainMap(map, { applyCommand: `node "${fwd(process.argv[1])}"` }));
  }
  process.exit(0);
}

// ---- --apply: add mounts to the current project ----
// Every refusal below this line and above the first createDomain happens before
// anything is written. From there the order is stores, then config, then the
// registry row, with no rollback: a failure part-way says what was already done.
if (!project) {
  const parent = enclosingProject(dirname(projectDir));
  if (parent) refuse(`${fwd(projectDir)} is inside the Sterling project at ${fwd(parent)}. Run the command from there. Nothing was written.`);
  refuse(`${fwd(projectDir)} is not an initialized Sterling project (no .sterling/config.json). Run /sterling:init there first.`);
}
for (const name of opts.add) {
  if (!name.trim() || name !== name.trim() || /[\\/]/.test(name) || name === '.' || name === '..') {
    refuse(`'${name}' is not a domain name: a domain name is one folder name under ~/.sterling/domains/, with no slash`);
  }
}
for (const name of opts.descriptions.keys()) {
  if (!opts.add.includes(name)) refuse(`--description names '${name}', which is not one of the --add domains (${opts.add.join(', ')})`);
}

const mounted = project.config.stack_tags;
// One subject, one store: a name that matches an existing store or tag in all
// but case would make a second store beside it.
{
  const stores = listStores().map((st) => st.name);
  for (const name of opts.add) {
    const differs = (other) => other !== name && other.toLowerCase() === name.toLowerCase();
    const exact = stores.includes(name) || projects.some((p) => p.exists && p.stack_tags.includes(name));
    if (exact) continue;
    const store = stores.find(differs);
    const user = projects.filter((p) => p.exists).map((p) => ({ p, tag: p.stack_tags.find(differs) })).find((x) => x.tag);
    if (store || user) {
      const existing = store ? `a store named '${store}' exists` : `${user.p.name} mounts '${user.tag}'`;
      refuse(`'${name}' differs only by case from an existing domain: ${existing}. Use that spelling (--add ${store ?? user.tag}) so there is one store for the subject. Nothing was written.`);
    }
  }
}
const wanted = [...new Set(opts.add)];
const toAdd = wanted.filter((name) => !mounted.includes(name));
// Every named domain is planned, a tag the project already lists included: such a
// tag may still name a store that was never created, and this is where it is made.
let planned;
if (onPostgres) {
  let schemaOf;
  try {
    schemaOf = new Map(pgStoreNames(route.projectId, wanted).domains.map((d) => [d.name, d.schema]));
  } catch (e) {
    refuse(`${e?.message ?? e} Nothing was written.`);
  }
  const have = new Set(listStores().map((st) => st.schema));
  planned = wanted.map((name) => ({ name, dbPath: `postgres:${schemaOf.get(name)}`, exists: have.has(schemaOf.get(name)) }));
  const absent = planned.filter((m) => !m.exists);
  if (absent.length) {
    refuse(
      `${absent.map((m) => `'${m.name}'`).join(', ')} ${absent.length === 1 ? 'has' : 'have'} no Postgres domain store, and this command creates domain stores only on SQLite storage: ${projectName} keeps its stores in Postgres (config.storage). ` +
        `Only domains whose Postgres store exists can be added here. Nothing was written.`
    );
  }
} else {
  planned = resolveDomainMounts({ stack_tags: wanted, domain_paths: project.config.domain_paths }).map((m) => ({ ...m, exists: existsSync(m.dbPath) }));
}
const plan = planned.map((m) => ({
  ...m,
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
const createdNames = [];
const partial = () => `${createdNames.length ? `Already created in this run: ${createdNames.map((n) => `'${n}'`).join(', ')} (the stores stay, with their descriptions).` : 'No store was created in this run.'}`;
for (const m of plan) {
  if (!m.exists) {
    try {
      createDomain(m.name, m.description, m.dbPath);
    } catch (e) {
      refuse(`the domain store '${m.name}' could not be created at ${fwd(m.dbPath)} (${e?.message ?? e}). ${partial()} stack_tags was not changed.`);
    }
    createdNames.push(m.name);
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
  try {
    const tmpPath = resolveStoreWritePath(project.dir, '.sterling', `config.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(nextRaw, null, 2) + (project.text.endsWith('\n') ? '\n' : ''));
    renameSync(tmpPath, project.configPath);
  } catch (e) {
    refuse(`.sterling/config.json could not be written (${e?.message ?? e}). ${partial()} stack_tags was not changed.`);
  }
  done.push(`stack_tags in .sterling/config.json: ${next.join(', ')}`);

  // Tags only: the row's init dates and version are init's to write.
  const mine = rows.filter(isCurrent);
  if (mine.length) {
    const registry = new ProjectRegistry(registryPath());
    try {
      for (const row of mine) registry.updateStackTags(row.repo_path, next);
    } finally {
      registry.close();
    }
    done.push('updated this project\'s tags in the project registry');
  } else done.push('this project has no registry row, so the registry was not changed (run /sterling:init to register it)');
}

console.log(`Applied to ${projectName} (${currentPath}):`);
for (const line of done) console.log(`  ${line}`);
for (const note of notes) console.log(`Note: ${note}`);
if (toAdd.length || created) {
  console.log('');
  console.log('Restart the session for the new mount to load: the Sterling MCP server mounts domains once, when it starts, so knowledge_query and knowledge_create do not see a new domain until then.');
  if (toAdd.length) console.log('AGENTS.md is not rewritten: update its "Stack tags" and "Domain stores" lines by hand to match.');
}
