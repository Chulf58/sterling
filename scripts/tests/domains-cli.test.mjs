// /sterling:domains (scripts/domains.mjs): the map printed from a real registry
// and real domain stores, and --apply adding a mount to the current project
// (decision consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command).
// It also pins the Domains section of a freshly generated AGENTS.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore, ProjectRegistry, createDomain } from '@sterling/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const fwd = (p) => p.replace(/\\/g, '/');
const domainDb = (home, name) => join(home, '.sterling', 'domains', name, 'sterling.db');
const configOf = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
function descriptionOf(path) {
  const s = new SterlingStore(path);
  try {
    return s.getMeta('description');
  } finally {
    s.close();
  }
}

// A machine in a scratch HOME: projects with a config, a registry, domain stores.
function machine() {
  const home = tmp('sterling-domains-home-');
  const registryDb = join(home, 'registry.db');
  const env = { ...process.env, HOME: home, STERLING_REGISTRY_DB: registryDb };
  const addProject = (name, tags, { register = true, extraConfig = {} } = {}) => {
    const dir = join(tmp('sterling-domains-proj-'), name);
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: name, stack_tags: tags, toolchains: [], backup_opt_out: true, ...extraConfig }, null, 2));
    if (register) {
      const registry = new ProjectRegistry(registryDb);
      try {
        registry.register({ repo_path: fwd(dir), name, stack_tags: tags, toolchains: [], sterling_version: '0.0.0', at: '2026-10-01T00:00:00.000Z' });
      } finally {
        registry.close();
      }
    }
    return dir;
  };
  const addStore = (name, description) => createDomain(name, description, domainDb(home, name));
  const run = (dir, args = []) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'domains.mjs'), ...args], { encoding: 'utf8', cwd: dir, timeout: 60_000, env });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const registered = () => {
    const registry = new ProjectRegistry(registryDb);
    try {
      return registry.list();
    } finally {
      registry.close();
    }
  };
  return { home, addProject, addStore, run, registered };
}

test('the default output is the map of every store and every registered project', () => {
  const m = machine();
  m.addStore('salesforce', 'Salesforce platform facts');
  m.addStore('sterling', 'Sterling facts');
  m.addStore('orphan', 'Nobody mounts this');
  const sf = m.addProject('Salesforce', ['genesys', 'sterling']);
  m.addProject('Genesys', ['salesforce', 'sterling']);
  const r = m.run(sf);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^Current project: Salesforce /m);
  assert.match(r.stdout, /^\s+salesforce\s+mounted by: Genesys\n\s+Salesforce platform facts$/m);
  assert.match(r.stdout, /^Stores no project mounts: orphan$/m);
  assert.match(r.stdout, /^Tags that name no store: genesys \(Salesforce\)$/m);
  assert.match(r.stdout, /add 'salesforce'/);
  assert.match(r.stdout, /In Genesys .*: add 'genesys'/);
  assert.match(r.stdout, /one user on one machine/);
});

test('--json prints the same map as JSON', () => {
  const m = machine();
  m.addStore('salesforce', 'Salesforce platform facts');
  m.addStore('sterling', 'Sterling facts');
  const sf = m.addProject('Salesforce', ['genesys', 'sterling']);
  const gen = m.addProject('Genesys', ['salesforce', 'sterling']);
  const r = m.run(sf, ['--json']);
  assert.equal(r.code, 0, r.out);
  const map = JSON.parse(r.stdout);
  assert.deepEqual(map.proposal.add.map((a) => a.domain), ['salesforce']);
  assert.deepEqual(map.proposal.sibling_steps, [{ project: 'Genesys', path: fwd(gen), add: ['genesys'] }]);
  assert.equal(map.domains.find((d) => d.name === 'salesforce').description, 'Salesforce platform facts');
  assert.equal(map.limits.length, 3);
  assert.ok(!r.stdout.includes('\\\\'), 'every path is printed with forward slashes');
});

test('an old-format store and an undescribed store are reported as such, and neither is written to', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  const legacy = domainDb(m.home, 'legacy');
  mkdirSync(dirname(legacy), { recursive: true });
  const db = new DatabaseSync(legacy);
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT); PRAGMA user_version = 1;');
  db.close();
  const bare = domainDb(m.home, 'bare');
  mkdirSync(dirname(bare), { recursive: true });
  new SterlingStore(bare).close();
  const legacyBytes = readFileSync(legacy);
  const dir = m.addProject('alpha', ['legacy', 'bare', 'sterling']);
  const r = m.run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^Stores in the old format: legacy$/m);
  assert.match(r.stdout, /^Stores with no description: bare$/m);
  assert.deepEqual(readFileSync(legacy), legacyBytes, 'the old-format store is read, never changed');
});

test('a project the registry does not list is registered by the run, and the output says so', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  m.addProject('beta', ['sterling']);
  const dir = m.addProject('alpha', ['sterling'], { register: false });
  const r = m.run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /was not in the project registry.*now registered/);
  assert.deepEqual(m.registered().map((p) => p.name), ['alpha', 'beta']);
  assert.doesNotMatch(m.run(dir).stdout, /now registered/, 'the second run finds it registered');
});

test('outside an initialized project the map still prints, with no current project and nothing registered', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  m.addProject('beta', ['sterling']);
  const r = m.run(tmp('sterling-domains-bare-'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^Current project: none/m);
  assert.match(r.stdout, /^\s+sterling\s+mounted by: beta$/m);
  assert.deepEqual(m.registered().map((p) => p.name), ['beta']);
});

test('--apply adds the tag, creates the described store, keeps every existing tag and refreshes the registry', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  m.addStore('genesys', 'Genesys facts');
  const sf = m.addProject('Salesforce', ['genesys', 'sterling'], { extraConfig: { mode: 'work' } });
  const gen = m.addProject('Genesys', ['salesforce', 'sterling']);
  const genConfig = readFileSync(join(gen, '.sterling', 'config.json'), 'utf8');
  const r = m.run(sf, ['--apply', '--add', 'salesforce', '--description', 'salesforce=Salesforce platform facts: objects, Apex, flows']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(configOf(sf).stack_tags, ['genesys', 'salesforce', 'sterling'], 'added before the universal sterling domain, nothing removed');
  assert.equal(configOf(sf).mode, 'work', 'every other key is kept');
  assert.equal(descriptionOf(domainDb(m.home, 'salesforce')), 'Salesforce platform facts: objects, Apex, flows');
  assert.deepEqual(m.registered().find((p) => p.name === 'Salesforce').stack_tags, ['genesys', 'salesforce', 'sterling']);
  assert.equal(readFileSync(join(gen, '.sterling', 'config.json'), 'utf8'), genConfig, 'another project is never touched');
  assert.match(r.stdout, /restart/i);
  // The Genesys side then needs no description: the store exists now.
  const g = m.run(gen, ['--apply', '--add', 'genesys']);
  assert.equal(g.code, 0, g.out);
  assert.deepEqual(configOf(gen).stack_tags, ['salesforce', 'genesys', 'sterling']);
  assert.equal(descriptionOf(domainDb(m.home, 'genesys')), 'Genesys facts', 'an existing store keeps its description');
  assert.deepEqual(JSON.parse(m.run(gen, ['--json']).stdout).proposal, { add: [], sibling_steps: [] });
});

test('--apply refuses a new store without a description, names the flag and writes nothing', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  m.addStore('genesys', 'Genesys facts');
  const sf = m.addProject('Salesforce', ['sterling']);
  const before = readFileSync(join(sf, '.sterling', 'config.json'), 'utf8');
  const r = m.run(sf, ['--apply', '--add', 'genesys', '--add', 'salesforce']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.stderr, /REFUSED.*'salesforce'.*--description salesforce=<text>/s);
  assert.equal(readFileSync(join(sf, '.sterling', 'config.json'), 'utf8'), before, 'the genesys tag is not added either: all or nothing');
  assert.ok(!existsSync(domainDb(m.home, 'salesforce')));
});

test('--apply refusals: no --add, --add without --apply, a description for a domain not added, a bad name, no project, an unknown flag', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  const dir = m.addProject('alpha', ['sterling']);
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  for (const [args, pattern] of [
    [['--apply'], /--add <domain>/],
    [['--add', 'node'], /--apply/],
    [['--apply', '--add', 'node', '--description', 'python=Python facts'], /'python'.*not.*--add/],
    [['--apply', '--add', '../escape', '--description', '../escape=x'], /not a domain name/],
    [['--apply', '--add', 'node', '--description', 'node'], /--description.*<domain>=<text>/],
    [['--remove', 'sterling'], /unrecognized argument '--remove'/],
  ]) {
    const r = m.run(dir, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.stderr, pattern, args.join(' '));
  }
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before);
  const outside = m.run(tmp('sterling-domains-bare-'), ['--apply', '--add', 'node', '--description', 'node=Node facts']);
  assert.equal(outside.code, 2, outside.out);
  assert.match(outside.stderr, /not an initialized Sterling project/);
});

test('--apply on a tag the project already mounts changes nothing and exits 0', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  m.addStore('node', 'Node facts');
  const dir = m.addProject('alpha', ['node', 'sterling']);
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  const r = m.run(dir, ['--apply', '--add', 'node']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /'node' is already mounted/);
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before);
});

test('--apply creates the store for a tag the project already lists but that has no store', () => {
  const m = machine();
  m.addStore('sterling', 'Sterling facts');
  const dir = m.addProject('alpha', ['ghost', 'sterling']);
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  const refused = m.run(dir, ['--apply', '--add', 'ghost']);
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.stderr, /--description ghost=<text>/);
  const r = m.run(dir, ['--apply', '--add', 'ghost', '--description', 'ghost=Ghost system facts']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(domainDb(m.home, 'ghost')), 'Ghost system facts');
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before, 'the tag was already listed, so the config is unchanged');
  assert.match(r.stdout, /restart/i);
});

// The generated AGENTS.md is one file both hosts read (Claude Code through
// CLAUDE.md's @AGENTS.md import, OpenCode natively), so it is rendered once per
// init whichever host is found.
for (const probe of ['ok', 'absent']) {
  test(`a fresh init writes the Domains section into AGENTS.md (Claude Code ${probe === 'ok' ? 'present' : 'absent, OpenCode only'})`, () => {
    const dir = tmp('sterling-domains-init-');
    const home = tmp('sterling-domains-home-');
    const r = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'init.mjs'), '--target', dir, '--project-name', 'domains-section', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--stack-tags', 'python', '--domain-description', 'python=Python language and tooling facts'],
      {
        encoding: 'utf8',
        cwd: dir,
        timeout: 180_000,
        env: {
          ...process.env,
          HOME: home,
          STERLING_REGISTRY_DB: join(dir, 'registry.db'),
          STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-domains-root-'),
          CLAUDE_CONFIG_DIR: tmp('sterling-domains-cfg-'),
          STERLING_CODEX_PROBE: 'absent',
          STERLING_CLAUDE_PROBE: probe,
          STERLING_OPENCODE_SETUP_DISABLE: '1',
        },
      }
    );
    assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const section = agentsMd.slice(agentsMd.indexOf('\n## Domains'), agentsMd.indexOf('\n## Conventions'));
    assert.match(section, /^\n## Domains\n/, 'the section sits between the project facts and the conventions');
    assert.ok(agentsMd.indexOf('- Stack tags') < agentsMd.indexOf('\n## Domains'), 'after the stack-tags lines');
    assert.match(section, /shared knowledge store for one subject/);
    assert.match(section, /its own subject included/);
    assert.match(section, /only through a domain both mount/);
    assert.match(section, /Salesforce project that mounts only `genesys`.*Genesys project that mounts only `salesforce` share nothing/);
    assert.match(section, /description/);
    assert.match(section, /\/sterling:domains/);
    assert.doesNotMatch(section, /—|\{\{/, 'plain words, no em dashes, no unresolved placeholder');
  });
}
