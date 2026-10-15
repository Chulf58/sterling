// domain-doctor `rename <old> <new> [--apply]` (issue #94, decision
// domain-rename-is-a-fenced-copy-verb-on-domain-doctor, board d75f3ef4).
//
// Every fixture owns its inputs: HOME points at a temp home (so the default
// domains root is <tmp>/home/.sterling/domains) and STERLING_REGISTRY_DB at a
// temp registry, so no test reads or writes this machine's ~/.sterling.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POSIX = (p) => p.replace(/\\/g, '/');

let SterlingStore;
let MountedStores;
let ProjectRegistry;
let StoreMovedError;
let createDomain;
let parseStoreFence;
let DatabaseSync;
before(async () => {
  ({ SterlingStore, MountedStores, ProjectRegistry, StoreMovedError, createDomain } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ parseStoreFence } = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href));
  ({ DatabaseSync } = await import('node:sqlite'));
});

// Distinct, descending stamps so no two seeds tie on updated_at.
let clock = Date.parse('2026-10-15T12:00:00.000Z');
const stamp = () => new Date((clock -= 1000)).toISOString();

function ref(scope, extra = {}) {
  const at = stamp();
  return {
    id: randomUUID(), type: 'reference_material', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope, stack_tags: ['chulf'], title: 'Customer hub API notes', kind: 'doc', location: 'docs/x.md', summary: 'how the hub API pages',
    source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform', ...extra,
  };
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function readRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** A machine: a temp home with the 'chulf' domain store, a registry, and three
 *  registered projects. alpha mounts chulf by the default path, beta through an
 *  explicit domain_paths entry, gamma does not mount it. */
function machine({ beta = {}, custom = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-rename-'));
  const home = join(dir, 'home');
  const domains = join(home, '.sterling', 'domains');
  // custom: the store lives outside the default root, named by domain_paths in every mounting project.
  const root = custom ? POSIX(join(dir, 'custom-domains')) : POSIX(domains);
  const oldPath = `${root}/chulf/sterling.db`;
  const newPath = `${root}/customerhub/sterling.db`;
  mkdirSync(dirname(oldPath), { recursive: true });
  createDomain('chulf', 'Customer hub integration knowledge', oldPath);
  const store = new SterlingStore(oldPath);
  const a = store.create(ref('domain:chulf'));
  const b = store.create(ref('domain:chulf', { title: 'Customer hub paging' }));
  store.updateRecord(a.id, { ...a, summary: 'how the hub API pages, revised', updated_at: new Date(Date.parse(a.created_at) + 60_000).toISOString() });
  store.addLink(b.id, 'cites', a.id);
  store.close();
  // An alias row, as the v1 -> v2 migration writes them (nothing else does),
  // so the copy is checked against a non-empty record_aliases table.
  const raw = new DatabaseSync(oldPath);
  raw.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)').run(randomUUID(), a.id, stamp());
  raw.close();

  const registryDb = join(dir, 'registry.db');
  const projects = {};
  const reg = new ProjectRegistry(registryDb);
  const configs = {
    alpha: custom ? { stack_tags: ['chulf', 'sterling'], domain_paths: { chulf: oldPath } } : { stack_tags: ['chulf', 'sterling'] },
    beta: { stack_tags: ['node', 'chulf'], domain_paths: { chulf: oldPath }, ...beta },
    gamma: { stack_tags: ['node'] },
  };
  for (const [name, config] of Object.entries(configs)) {
    const pdir = POSIX(join(dir, name));
    mkdirSync(join(pdir, '.sterling'), { recursive: true });
    writeFileSync(join(pdir, '.sterling', 'config.json'), JSON.stringify(config, null, 2) + '\n');
    reg.register({ repo_path: pdir, name, stack_tags: config.stack_tags, toolchains: [], sterling_version: null, at: stamp() });
    projects[name] = { dir: pdir, configPath: join(pdir, '.sterling', 'config.json') };
  }
  reg.close();
  writeFileSync(join(projects.alpha.dir, 'AGENTS.md'), '# AGENTS.md\n\nStack tags (= domain mount manifest): chulf, sterling.\nOther line.\n');
  return { dir, home, oldPath, newPath, registryDb, projects, ids: [a.id, b.id] };
}

function doctor(m, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd: m.dir,
    timeout: 60_000,
    env: { ...process.env, HOME: m.home, STERLING_REGISTRY_DB: m.registryDb, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** rename() called in a child through an import, with the crash seam set:
 *  the CLI never sets it, so this is the only way to reach it. argv[1] names
 *  this test file so the module's CLI dispatch does not run on import. */
function doctorCrash(m, args, crashAt) {
  const code =
    `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(import.meta.url))}, ...${JSON.stringify(args)}];` +
    `const { rename } = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts', 'domain-doctor.mjs')).href)});` +
    `rename({ crashAt: ${JSON.stringify(crashAt)} });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    cwd: m.dir,
    timeout: 60_000,
    env: { ...process.env, HOME: m.home, STERLING_REGISTRY_DB: m.registryDb },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const config = (p) => JSON.parse(readFileSync(p.configPath, 'utf8'));
const registryRows = (m) => Object.fromEntries(readRows(m.registryDb, 'SELECT name, stack_tags FROM projects').map((r) => [r.name, JSON.parse(r.stack_tags)]));
const fenceOf = (path) => readRows(path, "SELECT value FROM store_meta WHERE key = 'move_fence'")[0]?.value;

test('dry run prints the plan and writes nothing', () => {
  const m = machine();
  const before = { old: sha(m.oldPath), alpha: readFileSync(m.projects.alpha.configPath, 'utf8'), beta: readFileSync(m.projects.beta.configPath, 'utf8'), reg: registryRows(m) };
  const r = doctor(m, ['rename', 'chulf', 'customerhub']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rename domain 'chulf' → 'customerhub' \(dry run\)/);
  assert.match(r.stdout, /alpha .*stack_tags \[chulf, sterling\] → \[customerhub, sterling\]/);
  assert.match(r.stdout, /beta .*stack_tags \[node, chulf\] → \[node, customerhub\]; domain_paths 'chulf' → 'customerhub'/);
  assert.ok(r.stdout.includes(m.newPath), 'names the new store path');
  assert.match(r.stdout, /AGENTS\.md:3\n\s+- Stack tags \(= domain mount manifest\): chulf, sterling\.\n\s+\+ Stack tags \(= domain mount manifest\): customerhub, sterling\./);
  assert.match(r.stdout, /Dry run: nothing was written/);
  assert.doesNotMatch(r.stdout, /gamma/);
  assert.equal(sha(m.oldPath), before.old);
  assert.equal(readFileSync(m.projects.alpha.configPath, 'utf8'), before.alpha);
  assert.equal(readFileSync(m.projects.beta.configPath, 'utf8'), before.beta);
  assert.deepEqual(registryRows(m), before.reg);
  assert.equal(existsSync(dirname(m.newPath)), false);
  assert.equal(fenceOf(m.oldPath), undefined);
});

test('--apply renames: copy rescoped with ids, versions, aliases and relations intact; configs and registry rewritten; old store fenced; a running store on the old file refuses writes', () => {
  const m = machine();
  const running = new SterlingStore(m.oldPath);
  const oldVersions = readRows(m.oldPath, 'SELECT * FROM record_versions ORDER BY record_id, version');
  const oldRelations = readRows(m.oldPath, 'SELECT * FROM record_relations ORDER BY source_id, rel, target_id');
  const oldAliases = readRows(m.oldPath, 'SELECT * FROM record_aliases ORDER BY historical_id');
  const oldStackTags = readRows(m.oldPath, 'SELECT * FROM record_stack_tags ORDER BY record_id, tag');
  const oldFts = readRows(m.oldPath, 'SELECT record_id, text FROM records_fts ORDER BY record_id');
  assert.ok(oldVersions.length > 0 && oldRelations.length > 0 && oldAliases.length > 0, 'the fixture has history to carry');
  const agentsBefore = readFileSync(join(m.projects.alpha.dir, 'AGENTS.md'), 'utf8');
  const gammaBefore = readFileSync(m.projects.gamma.configPath, 'utf8');

  const r = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /RENAMED 'chulf' to 'customerhub'/);

  try {
    // A session that had the old store open: its next write is refused, naming the new domain.
    assert.throws(() => running.create(ref('domain:chulf')), (e) => e instanceof StoreMovedError && e.renamed_to === 'customerhub' && /now 'customerhub'/.test(e.message));
  } finally {
    running.close();
  }

  // The copy.
  const rows = readRows(m.newPath, 'SELECT id, scope, body FROM records ORDER BY id');
  assert.deepEqual(rows.map((x) => x.id), [...m.ids].sort());
  for (const row of rows) {
    assert.equal(row.scope, 'domain:customerhub');
    assert.equal(JSON.parse(row.body).scope, 'domain:customerhub');
    assert.deepEqual(JSON.parse(row.body).stack_tags, ['chulf'], 'record stack_tags are subject tags and are not rewritten');
  }
  assert.deepEqual(readRows(m.newPath, 'SELECT * FROM record_versions ORDER BY record_id, version'), oldVersions, 'record_versions byte-exact');
  assert.deepEqual(readRows(m.newPath, 'SELECT * FROM record_relations ORDER BY source_id, rel, target_id'), oldRelations);
  assert.deepEqual(readRows(m.newPath, 'SELECT * FROM record_aliases ORDER BY historical_id'), oldAliases);
  assert.deepEqual(readRows(m.newPath, 'SELECT * FROM record_stack_tags ORDER BY record_id, tag'), oldStackTags);
  assert.deepEqual(readRows(m.newPath, 'SELECT record_id, text FROM records_fts ORDER BY record_id'), oldFts);
  assert.equal(readRows(m.newPath, "SELECT value FROM store_meta WHERE key = 'description'")[0].value, 'Customer hub integration knowledge');
  assert.equal(fenceOf(m.newPath), undefined, 'the copy carries no fence');
  const receipt = JSON.parse(readRows(m.newPath, "SELECT value FROM store_meta WHERE key = 'rename_receipt'")[0].value);

  // The old store: fenced with the same operation, kept as the backup, records untouched.
  const fence = parseStoreFence(fenceOf(m.oldPath));
  assert.equal(fence.kind, 'rename');
  assert.equal(fence.to_domain, 'customerhub');
  assert.equal(fence.operation_id, receipt.operation_id);
  assert.ok(readRows(m.oldPath, 'SELECT scope FROM records').every((x) => x.scope === 'domain:chulf'));

  // Configs and registry rows.
  assert.deepEqual(config(m.projects.alpha).stack_tags, ['customerhub', 'sterling']);
  assert.equal(config(m.projects.alpha).domain_paths, undefined, 'a project on the default path gets no domain_paths entry');
  assert.deepEqual(config(m.projects.beta).stack_tags, ['node', 'customerhub']);
  assert.deepEqual(config(m.projects.beta).domain_paths, { customerhub: m.newPath });
  assert.equal(readFileSync(m.projects.gamma.configPath, 'utf8'), gammaBefore);
  assert.deepEqual(registryRows(m), { alpha: ['customerhub', 'sterling'], beta: ['node', 'customerhub'], gamma: ['node'] });
  assert.equal(readFileSync(join(m.projects.alpha.dir, 'AGENTS.md'), 'utf8'), agentsBefore, 'another repo\'s AGENTS.md is printed, never edited');

  // Mounted under the new name, a session reads the records with their new scope.
  const mounted = new MountedStores(join(m.dir, 'project.db'), [{ name: 'customerhub', dbPath: m.newPath }]);
  try {
    assert.equal(mounted.unreadableDomains.length, 0);
    assert.equal(mounted.get(m.ids[0]).scope, 'domain:customerhub');
  } finally {
    mounted.close();
  }
  // Mounted under the old name, the fenced store is refused loudly.
  const stale = new MountedStores(join(m.dir, 'project2.db'), [{ name: 'chulf', dbPath: m.oldPath }]);
  try {
    assert.equal(stale.unreadableDomains.length, 1);
    assert.match(stale.unreadableDomains[0].error, /renamed to 'customerhub'/);
    assert.equal(stale.get(m.ids[0]), undefined);
  } finally {
    stale.close();
  }

  // A second rename of the old name to anything else is refused.
  const again = doctor(m, ['rename', 'chulf', 'other', '--apply']);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already renamed from 'chulf' to 'customerhub'/);
});

test('a crash between publishing the copy and rewriting configs resumes from the receipt', () => {
  const m = machine();
  const crashed = doctorCrash(m, ['rename', 'chulf', 'customerhub', '--apply'], 'after-publish');
  assert.equal(crashed.code, 70, crashed.stderr);
  assert.ok(existsSync(m.newPath), 'the copy was published');
  assert.deepEqual(config(m.projects.alpha).stack_tags, ['chulf', 'sterling'], 'no config was rewritten before the crash');
  const fence = parseStoreFence(fenceOf(m.oldPath));
  const ino = statSync(m.newPath).ino;

  // A fresh rename of the same name to another target cannot start over it.
  const other = doctor(m, ['rename', 'chulf', 'elsewhere', '--apply']);
  assert.equal(other.code, 2);

  const resumed = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`resuming operation ${fence.operation_id} \\(old store fenced at [^;]+; renamed copy published\\)`));
  assert.doesNotMatch(resumed.stdout, /published the renamed copy/, 'the copy is not made twice');
  assert.equal(statSync(m.newPath).ino, ino, 'the published store is the same file');
  assert.deepEqual(config(m.projects.alpha).stack_tags, ['customerhub', 'sterling']);
  assert.deepEqual(config(m.projects.beta).domain_paths, { customerhub: m.newPath });
  assert.deepEqual(registryRows(m).beta, ['node', 'customerhub']);
});

test('a crash after fencing, before the copy, resumes by making the copy under the same operation', () => {
  const m = machine();
  const crashed = doctorCrash(m, ['rename', 'chulf', 'customerhub', '--apply'], 'after-fence');
  assert.equal(crashed.code, 70, crashed.stderr);
  assert.equal(existsSync(m.newPath), false);
  const fence = parseStoreFence(fenceOf(m.oldPath));
  const resumed = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(resumed.code, 0, resumed.stderr);
  const receipt = JSON.parse(readRows(m.newPath, "SELECT value FROM store_meta WHERE key = 'rename_receipt'")[0].value);
  assert.equal(receipt.operation_id, fence.operation_id);
  assert.deepEqual(config(m.projects.alpha).stack_tags, ['customerhub', 'sterling']);
});

test('a record with an unexpected source scope aborts the rename with nothing fenced, published or rewritten', () => {
  const m = machine();
  const s = new SterlingStore(m.oldPath);
  const stray = s.create(ref('project'));
  s.close();
  const oldHash = sha(m.oldPath);
  const alpha = readFileSync(m.projects.alpha.configPath, 'utf8');
  const r = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(`${stray.id} records\\.scope=project`));
  assert.equal(existsSync(m.newPath), false, 'nothing published');
  assert.equal(existsSync(dirname(m.newPath)), false);
  assert.equal(fenceOf(m.oldPath), undefined, 'the old store was not fenced');
  assert.equal(sha(m.oldPath), oldHash);
  assert.equal(readFileSync(m.projects.alpha.configPath, 'utf8'), alpha);
});

test('refusals: an existing target, a Postgres project, disagreeing store paths, a name outside SCOPE_RE', () => {
  const m = machine();
  mkdirSync(dirname(m.newPath), { recursive: true });
  createDomain('customerhub', 'already here', m.newPath);
  const exists = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(exists.code, 2);
  assert.match(exists.stderr, /already has a store/);
  assert.equal(fenceOf(m.oldPath), undefined);

  const pg = machine({ beta: { storage: 'postgres' } });
  const pgRun = doctor(pg, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(pgRun.code, 2);
  assert.match(pgRun.stderr, /beta .*Postgres/);
  assert.equal(fenceOf(pg.oldPath), undefined);

  const split = machine();
  const otherPath = POSIX(join(split.dir, 'elsewhere', 'chulf', 'sterling.db'));
  mkdirSync(dirname(otherPath), { recursive: true });
  createDomain('chulf', 'a second chulf', otherPath);
  writeFileSync(split.projects.beta.configPath, JSON.stringify({ stack_tags: ['chulf'], domain_paths: { chulf: otherPath } }));
  const splitRun = doctor(split, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(splitRun.code, 2);
  assert.match(splitRun.stderr, /do not agree on its store/);
  assert.equal(fenceOf(split.oldPath), undefined);

  const bad = doctor(split, ['rename', 'chulf', 'Customer Hub']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /is not a domain name/);
});

test('the domains map shows a rename-fenced store as a renamed backup, and --apply --add refuses the old name', () => {
  const m = machine();
  assert.equal(doctor(m, ['rename', 'chulf', 'customerhub', '--apply']).code, 0);
  const env = { ...process.env, HOME: m.home, STERLING_REGISTRY_DB: m.registryDb };
  const map = spawnSync(process.execPath, [join(root, 'scripts', 'domains.mjs'), '--target', m.projects.gamma.dir], { encoding: 'utf8', cwd: m.dir, env, timeout: 60_000 });
  assert.equal(map.status, 0, map.stderr);
  assert.match(map.stdout, /^ {2}chulf\s+mounted by: none\n\s+\(renamed → customerhub \(fenced backup\)\)$/m);
  assert.match(map.stdout, /Renamed domains \(fenced backups\): chulf → customerhub/);
  assert.match(map.stdout, /Stores no project mounts: none/, 'the backup is not listed as an ordinary unmounted store');
  const add = spawnSync(process.execPath, [join(root, 'scripts', 'domains.mjs'), '--apply', '--add', 'chulf'], { encoding: 'utf8', cwd: m.projects.gamma.dir, env, timeout: 60_000 });
  assert.equal(add.status, 2);
  assert.match(add.stderr, /'chulf' was renamed to 'customerhub'.*Add 'customerhub' instead/);
  assert.deepEqual(config(m.projects.gamma).stack_tags, ['node']);
});

test('bin/domain-doctor.mjs ships the rename verb and runs from a plugin tree with no node_modules', () => {
  const m = machine();
  const plugin = join(m.dir, 'plugin');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  const bundle = join(plugin, 'bin', 'domain-doctor.mjs');
  writeFileSync(bundle, readFileSync(join(root, 'bin', 'domain-doctor.mjs')));
  const run = (args) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', cwd: m.dir, timeout: 60_000, env: { ...process.env, HOME: m.home, STERLING_REGISTRY_DB: m.registryDb } });

  const help = run(['rename', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: domain-doctor\.mjs rename <old> <new> \[--apply\]/);
  // A usage error is printed, never a silent exit 0 (anti_pattern bin-bundle-main-guard-compares-against-source-path-and-never-runs).
  const usage = run(['rename']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: domain-doctor\.mjs rename/);

  const dry = run(['rename', 'chulf', 'customerhub']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run: nothing was written/);
  assert.equal(existsSync(m.newPath), false);

  const skill = readFileSync(join(root, 'skills', 'mounting-domains', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/domain-doctor.mjs" rename <old> <new>'), 'the skill runs the shipped bundle');
});

test('an unreadable config of a registered project refuses the rename before anything is written, naming every blocked project; a missing folder is skipped', () => {
  const m = machine();
  writeFileSync(m.projects.gamma.configPath, '{ not json');
  writeFileSync(m.projects.beta.configPath, JSON.stringify({ stack_tags: 'chulf' }));
  const reg = new ProjectRegistry(m.registryDb);
  reg.register({ repo_path: POSIX(join(m.dir, 'gone')), name: 'gone', stack_tags: ['chulf'], toolchains: [], sterling_version: null, at: stamp() });
  reg.close();
  const oldHash = sha(m.oldPath);
  const alpha = readFileSync(m.projects.alpha.configPath, 'utf8');
  for (const args of [['rename', 'chulf', 'customerhub'], ['rename', 'chulf', 'customerhub', '--apply']]) {
    const r = doctor(m, args);
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stderr, /2 registered project config\(s\) cannot be read/);
    assert.match(r.stderr, /gamma \(/);
    assert.match(r.stderr, /beta \(/);
    assert.doesNotMatch(r.stderr, /gone/, 'a registered folder that no longer exists is not a blocker');
  }
  assert.equal(fenceOf(m.oldPath), undefined);
  assert.equal(sha(m.oldPath), oldHash);
  assert.equal(existsSync(dirname(m.newPath)), false);
  assert.equal(readFileSync(m.projects.alpha.configPath, 'utf8'), alpha);

  // With the configs repaired, the missing folder is reported as skipped and the rename runs.
  writeFileSync(m.projects.gamma.configPath, JSON.stringify({ stack_tags: ['node'] }));
  writeFileSync(m.projects.beta.configPath, JSON.stringify({ stack_tags: ['node', 'chulf'], domain_paths: { chulf: m.oldPath } }));
  const ok = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /skipped \(registered path does not exist, not rewritten\): gone/);
});

test('a custom-path store: a stop after every config is rewritten and before the registry rows are, resumes from the receipt', () => {
  const m = machine({ custom: true });
  assert.ok(!m.oldPath.includes('/home/'), 'the store is outside the default domains root');
  const crashed = doctorCrash(m, ['rename', 'chulf', 'customerhub', '--apply'], 'after-configs');
  assert.equal(crashed.code, 70, crashed.stderr);
  assert.deepEqual(config(m.projects.alpha).domain_paths, { customerhub: m.newPath });
  assert.deepEqual(config(m.projects.beta).domain_paths, { customerhub: m.newPath });
  assert.deepEqual(registryRows(m).alpha, ['chulf', 'sterling'], 'the registry row was not updated before the stop');

  const resumed = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.ok(resumed.stdout.includes(`old store: ${m.oldPath}`), 'the old store path is recovered from the receipt, not the default root');
  assert.match(resumed.stdout, /resuming operation/);
  assert.deepEqual(registryRows(m), { alpha: ['customerhub', 'sterling'], beta: ['node', 'customerhub'], gamma: ['node'] });
});

test('the shipped bin ignores STERLING_TEST_RENAME_CRASH_AT: the crash seam is reachable only through an import', () => {
  const m = machine();
  const r = spawnSync(process.execPath, [join(root, 'bin', 'domain-doctor.mjs'), 'rename', 'chulf', 'customerhub', '--apply'], {
    encoding: 'utf8', cwd: m.dir, timeout: 60_000,
    env: { ...process.env, HOME: m.home, STERLING_REGISTRY_DB: m.registryDb, STERLING_TEST_RENAME_CRASH_AT: 'after-publish' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /test crash/);
  assert.deepEqual(config(m.projects.alpha).stack_tags, ['customerhub', 'sterling']);
  assert.ok(!readFileSync(join(root, 'bin', 'domain-doctor.mjs'), 'utf8').includes('STERLING_TEST_RENAME_CRASH_AT'), 'the bundle does not read the variable');
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('an inaccessible .sterling folder of a registered project refuses the rename with nothing written', { skip: isRoot ? 'running as root: chmod 000 does not deny root' : process.platform === 'win32' ? 'chmod does not deny on Windows' : false }, () => {
  const m = machine();
  const dotDir = join(m.projects.gamma.dir, '.sterling');
  const oldHash = sha(m.oldPath);
  const alpha = readFileSync(m.projects.alpha.configPath, 'utf8');
  chmodSync(dotDir, 0o000);
  let r;
  try {
    r = doctor(m, ['rename', 'chulf', 'customerhub', '--apply']);
  } finally {
    chmodSync(dotDir, 0o755);
  }
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /1 registered project config\(s\) cannot be read/);
  assert.match(r.stderr, /gamma \(.*\.sterling\/config\.json cannot be read \(EACCES/);
  assert.equal(fenceOf(m.oldPath), undefined);
  assert.equal(sha(m.oldPath), oldHash);
  assert.equal(existsSync(dirname(m.newPath)), false);
  assert.equal(readFileSync(m.projects.alpha.configPath, 'utf8'), alpha);
});

test('a registered folder that exists with no .sterling/config.json is skipped and reported', () => {
  const m = machine();
  const bare = POSIX(join(m.dir, 'bare'));
  mkdirSync(bare);
  const reg = new ProjectRegistry(m.registryDb);
  reg.register({ repo_path: bare, name: 'bare', stack_tags: ['chulf'], toolchains: [], sterling_version: null, at: stamp() });
  reg.close();
  const r = doctor(m, ['rename', 'chulf', 'customerhub']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /skipped \(no \.sterling\/config\.json, not rewritten\): bare/);
});
