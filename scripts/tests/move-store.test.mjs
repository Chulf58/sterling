// scripts/move-store.mjs: the CLI over packages/store/src/store-move.ts.
// One run moves the invoking project and its mounted domains only
// (user-ruled 2026-10-06, "Drop --all: project only").
//
// The refusal tests run everywhere. The Postgres tests need STERLING_TEST_PG=1
// and skip by name without it; they point the CLI at a sterling_test_<random>
// namespace through STERLING_TEST_PG_NAMESPACE and drop it afterwards. Every
// project, domain store and the registry are fixtures in temp directories.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../packages/store/dist/index.js';
import { MoveCredentialsError, readSqliteFence, readSqliteReceipt, readPgFence, latestPgReceipt, snapshotSqliteStore, buildManifest } from '../../packages/store/dist/store-move.js';
import { PG_SKIP, dropTestSchemas, openTestBridge } from '../../packages/store/dist/tests/pg-test-support.js';
import { decision, openSqliteStore, seedStore } from '../../packages/store/dist/tests/store-move-fixture.js';
import { openRoutedStores } from '../../packages/store/dist/routing.js';
import { MoveStoreUsageError, findProjectRoot, formatAttachReport, formatReport, parseArgs, runAttach, runMoveStore } from '../move-store.mjs';

const temps = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-move-cli-'));
  temps.push(d);
  return d;
}

const ns = `sterling_test_mv${randomBytes(5).toString('hex')}`;
process.env.STERLING_TEST_PG_NAMESPACE = ns;
let usedPg = false;
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  if (!usedPg) return;
  const bridge = openTestBridge();
  try {
    dropTestSchemas(bridge, ns);
  } finally {
    bridge.close();
  }
});

function project(dir, { mode = 'work', stack = [], domainPaths = {} } = {}) {
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode, stack_tags: stack, domain_paths: domainPaths }, null, 2));
  writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: randomUUID() }));
  return dir;
}

function registry(dir, roots) {
  const path = join(dir, 'registry.db');
  const reg = new ProjectRegistry(path);
  try {
    for (const root of roots) reg.register({ repo_path: root, name: root, stack_tags: [], toolchains: [], sterling_version: null, at: '2026-10-06T08:00:00.000Z' });
  } finally {
    reg.close();
  }
  return path;
}

const configOf = (root) => JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8'));
const modeOf = (root) => configOf(root).mode;
const storageOf = (root) => configOf(root).storage;

test('parseArgs: --to is required and must be pg or sqlite; --all does not exist', () => {
  assert.deepEqual(parseArgs(['--to', 'pg']), { to: 'pg', dryRun: false, project: undefined, confirmFork: false });
  assert.deepEqual(parseArgs(['--to=sqlite', '--dry-run']), { to: 'sqlite', dryRun: true, project: undefined, confirmFork: false });
  assert.throws(() => parseArgs([]), MoveStoreUsageError);
  assert.throws(() => parseArgs(['--to', 'mysql']), MoveStoreUsageError);
  assert.throws(() => parseArgs(['--to', 'pg', '--all']), (e) => e instanceof MoveStoreUsageError && e.message.includes("'--all'"));
});

test('parseArgs: --attach takes --fence-local, --dry-run and --project but no --to; --fence-local needs --attach', () => {
  assert.deepEqual(parseArgs(['--attach']), { attach: true, fenceLocal: false, dryRun: false, project: undefined });
  assert.deepEqual(parseArgs(['--attach', '--fence-local', '--dry-run', '--project=/p']), { attach: true, fenceLocal: true, dryRun: true, project: '/p' });
  assert.throws(() => parseArgs(['--attach', '--to', 'pg']), (e) => e instanceof MoveStoreUsageError && e.message.includes('--attach copies nothing'));
  assert.throws(() => parseArgs(['--to', 'pg', '--fence-local']), (e) => e instanceof MoveStoreUsageError && e.message.includes('only for --attach'));
  assert.match(new MoveStoreUsageError('x').message, /--attach \[--fence-local\]/);
});

test('parseArgs: --confirm-fork goes with --to pg only', () => {
  assert.deepEqual(parseArgs(['--to', 'pg', '--confirm-fork']), { to: 'pg', dryRun: false, project: undefined, confirmFork: true });
  assert.throws(() => parseArgs(['--to', 'sqlite', '--confirm-fork']), (e) => e instanceof MoveStoreUsageError && e.message.includes('--confirm-fork is only for --to pg'));
  assert.throws(() => parseArgs(['--attach', '--confirm-fork']), (e) => e instanceof MoveStoreUsageError && e.message.includes('--confirm-fork is only for --to pg'));
  assert.match(new MoveStoreUsageError('x').message, /--to pg\|sqlite \[--confirm-fork\]/);
});

test('parseArgs: a bare --to or --project, or one followed by another option, is a usage error', () => {
  const usage = (argv, text) => assert.throws(() => parseArgs(argv), (e) => e instanceof MoveStoreUsageError && e.message.includes(text), argv.join(' '));
  usage(['--attach', '--project', '/p', '--to'], '--to needs a value');
  usage(['--to'], '--to needs a value');
  usage(['--to', '--dry-run'], '--to needs a value');
  usage(['--attach', '--to='], '--attach copies nothing and takes no --to');
  usage(['--attach', '--project'], '--project needs a directory');
  usage(['--to', 'pg', '--project', '--dry-run'], '--project needs a directory');
});

test('--attach: credentials are checked before any connection, and the config is left as found', () => {
  const base = tempDir();
  const work = project(join(base, 'work'));
  const before = readFileSync(join(work, '.sterling', 'config.json'), 'utf8');
  assert.throws(() => runAttach({ root: work, credentialsPath: join(base, 'missing.json') }), (e) => e.name === 'MoveCredentialsError');
  assert.equal(readFileSync(join(work, '.sterling', 'config.json'), 'utf8'), before);
});

test('findProjectRoot: walks up to the directory holding .sterling/config.json', () => {
  const root = project(join(tempDir(), 'p'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  assert.equal(findProjectRoot(join(root, 'src', 'deep')), root);
});

test('a hobby project is no longer refused for --to pg on its mode: the move stops at the next precondition (no credentials file) and nothing is touched', () => {
  const base = tempDir();
  const domain = join(base, 'domains', 'node.db');
  seedStore(domain, { label: 'hobby-domain' });
  const hobby = project(join(base, 'hobby'), { mode: 'hobby', stack: ['node'], domainPaths: { node: domain } });
  const configBefore = readFileSync(join(hobby, '.sterling', 'config.json'), 'utf8');
  const digest = buildManifest(snapshotSqliteStore(domain)).manifest.digest;
  assert.throws(
    () => runMoveStore({ root: hobby, to: 'pg', credentialsPath: join(base, 'no-credentials.json'), registryDb: join(base, 'registry.db') }),
    (e) => e instanceof MoveCredentialsError && !e.message.includes('hobby project'),
  );
  assert.equal(readFileSync(join(hobby, '.sterling', 'config.json'), 'utf8'), configBefore);
  assert.equal(existsSync(join(hobby, '.sterling', 'sterling.db')), false);
  assert.equal(readSqliteFence(domain), null);
  assert.equal(buildManifest(snapshotSqliteStore(domain)).manifest.digest, digest);
});

test('--to pg: a shared domain a hobby project mounts is copied, not fenced, and named; the way back refuses the diverged fork by name', { skip: PG_SKIP }, () => {
  usedPg = true;
  const base = tempDir();
  const shared = join(base, 'domains', 'shared.db');
  const own = join(base, 'domains', 'own.db');
  seedStore(shared, { label: 'shared' });
  seedStore(own, { label: 'own' });
  const work = project(join(base, 'work'), { stack: ['shared', 'own'], domainPaths: { shared, own } });
  seedStore(join(work, '.sterling', 'sterling.db'), { label: 'work' });
  const hobby = project(join(base, 'hobby'), { mode: 'hobby', stack: ['shared'], domainPaths: { shared } });
  const registryDb = registry(base, [work, hobby]);

  const report = runMoveStore({ root: work, to: 'pg', registryDb });
  assert.equal(report.failure, null);
  assert.deepEqual(report.stores.map((s) => [s.identity.kind, s.outcome, s.hash_match, s.source_fenced]), [
    ['project', 'copied', true, true],
    ['domain', 'copied', true, false],
    ['domain', 'copied', true, true],
  ]);
  assert.deepEqual(report.stores[1].sharedWith, [{ root: hobby, mode: 'hobby', storage: 'sqlite' }]);
  const text = formatReport(report);
  assert.match(text, /shared domain, NOT fenced: its SQLite copy stays writable for .*hobby \(hobby, storage sqlite\)/);
  assert.match(text, /ids per table: records \d+, record_versions \d+/);
  assert.equal(readSqliteFence(shared), null, 'the hobby project keeps writing its SQLite copy');
  assert.ok(readSqliteFence(own), 'the work-only domain is fenced');
  assert.ok(readSqliteFence(join(work, '.sterling', 'sterling.db')), 'the project store is fenced');
  assert.equal(modeOf(hobby), 'hobby');
  assert.equal(storageOf(hobby), undefined, 'the hobby project is untouched');
  assert.equal(modeOf(work), 'work', 'mode is never written by the move');
  assert.equal(storageOf(work), 'postgres');
  assert.match(text, /config\.storage switched to postgres/);

  // Back to SQLite: the forked copy has diverged, so the move is refused by name before any store is fenced.
  const back = runMoveStore({ root: work, to: 'sqlite', registryDb });
  assert.equal(back.failure?.name, 'MoveForkDivergedError');
  assert.deepEqual(back.failure.identity, { kind: 'domain', name: 'shared' });
  assert.ok(back.failure.message.includes("domain 'shared'") && back.failure.message.includes(hobby) && back.failure.message.includes('diverged'), back.failure.message);
  assert.deepEqual(back.stores, [], 'nothing was moved');
  const bridge = openTestBridge();
  try {
    for (const s of report.stores) assert.equal(readPgFence(bridge, s.target.replace(/^postgres:/, '')), null, `${s.target} was not fenced`);
  } finally {
    bridge.close();
  }
  assert.equal(readSqliteReceipt(join(work, '.sterling', 'sterling.db')), null, 'the project store was not moved back');
  assert.equal(storageOf(work), 'postgres', 'no storage switch after a refusal');
  assert.equal(modeOf(work), 'work');
});

test('--to pg: a domain a work project still on SQLite mounts stays unfenced; when that project moves later it is shown what will not carry over and refused until --confirm-fork', { skip: PG_SKIP }, () => {
  usedPg = true;
  const base = tempDir();
  // Its own domain name: the hobby test above already moved a domain 'shared' into this file's namespace.
  const shared = join(base, 'domains', 'workshared.db');
  seedStore(shared, { label: 'shared-work' });
  const first = project(join(base, 'first'), { stack: ['workshared'], domainPaths: { workshared: shared } });
  const second = project(join(base, 'second'), { stack: ['workshared'], domainPaths: { workshared: shared } });
  seedStore(join(first, '.sterling', 'sterling.db'), { label: 'first' });
  seedStore(join(second, '.sterling', 'sterling.db'), { label: 'second' });
  const registryDb = registry(base, [first, second]);

  const one = runMoveStore({ root: first, to: 'pg', registryDb });
  assert.equal(one.failure, null);
  assert.deepEqual(one.stores[1].sharedWith, [{ root: second, mode: 'work', storage: 'sqlite' }]);
  assert.equal(one.stores[1].source_fenced, false);
  assert.equal(readSqliteFence(shared), null, 'the work project still on SQLite keeps writing the domain');
  assert.match(formatReport(one), /its SQLite copy stays writable for .*second \(work, storage sqlite\)/);

  // The project still on SQLite writes to the domain, then moves.
  const store = openSqliteStore(shared);
  const added = store.create(decision({ title: 'written by the second project before its move' }));
  store.close();
  const configBefore = readFileSync(join(second, '.sterling', 'config.json'), 'utf8');
  const two = runMoveStore({ root: second, to: 'pg', registryDb });
  assert.equal(two.failure?.name, 'MoveForkUnconfirmedError');
  assert.deepEqual(two.failure.identity, { kind: 'domain', name: 'workshared' });
  assert.ok(two.failure.message.includes(added.id) && two.failure.message.includes('written by the second project before its move') && two.failure.message.includes('--confirm-fork'), two.failure.message);
  assert.deepEqual(two.stores, [], 'nothing was moved');
  assert.equal(readSqliteFence(shared), null);
  assert.equal(readSqliteFence(join(second, '.sterling', 'sterling.db')), null);
  assert.equal(readFileSync(join(second, '.sterling', 'config.json'), 'utf8'), configBefore, 'config.storage not switched');

  const three = runMoveStore({ root: second, to: 'pg', registryDb, confirmFork: true });
  assert.equal(three.failure, null);
  assert.deepEqual(three.stores.map((s) => [s.identity.kind, s.outcome, s.source_fenced]), [
    ['project', 'copied', true],
    ['domain', 'fork_already_copied', true],
  ]);
  assert.deepEqual(three.stores[1].sharedWith, [], 'every project mounting it is on Postgres now');
  assert.ok(readSqliteFence(shared), 'so the SQLite copy is fenced');
  const text = formatReport(three);
  assert.match(text, /already forked, NOT copied again \(--confirm-fork\); nothing below carries over: 1 record\(s\) only in the SQLite copy, 0 only in Postgres, 0 that differ/);
  assert.ok(text.includes(added.id), text);
  assert.equal(storageOf(second), 'postgres');
});

test('--to sqlite: a crash after the receipts and before the storage switch is completed by a re-run', { skip: PG_SKIP }, () => {
  usedPg = true;
  const base = tempDir();
  const domain = join(base, 'domains', 'solo.db');
  seedStore(domain, { label: 'solo' });
  const work = project(join(base, 'work'), { stack: ['solo'], domainPaths: { solo: domain } });
  const projectDb = join(work, '.sterling', 'sterling.db');
  seedStore(projectDb, { label: 'crash' });
  const registryDb = registry(base, [work]);
  const digests = [projectDb, domain].map((p) => buildManifest(snapshotSqliteStore(p)).manifest.digest);

  let seenBeforeSwitch = null;
  const up = runMoveStore({
    root: work,
    to: 'pg',
    registryDb,
    hooks: {
      beforeStorageSwitch: (r) => {
        const bridge = openTestBridge();
        try {
          seenBeforeSwitch = { storage: storageOf(work), receipts: r.stores.map((s) => latestPgReceipt(bridge, r.metaSchema, s.target.replace(/^postgres:/, ''))?.move_id === s.move_id) };
        } finally {
          bridge.close();
        }
      },
    },
  });
  assert.equal(up.failure, null);
  assert.deepEqual(seenBeforeSwitch, { storage: undefined, receipts: [true, true] }, 'every receipt committed while storage was still unset');
  assert.equal(up.storageSwitched, true);
  assert.equal(storageOf(work), 'postgres');
  assert.equal(modeOf(work), 'work');

  assert.throws(
    () =>
      runMoveStore({
        root: work,
        to: 'sqlite',
        registryDb,
        hooks: {
          beforeStorageSwitch: () => {
            assert.equal(storageOf(work), 'postgres', 'storage is untouched until the receipts are in');
            assert.ok(readSqliteReceipt(projectDb) && readSqliteReceipt(domain), 'both SQLite receipts committed before the switch');
            throw new Error('injected crash after the receipts');
          },
        },
      }),
    /injected crash/,
  );
  assert.equal(storageOf(work), 'postgres', 'the crash left storage unswitched');
  assert.equal(modeOf(work), 'work');
  const bridge = openTestBridge();
  try {
    for (const s of up.stores) assert.ok(readPgFence(bridge, s.target.replace(/^postgres:/, '')), `${s.target} is fenced`);
  } finally {
    bridge.close();
  }

  const rerun = runMoveStore({ root: work, to: 'sqlite', registryDb });
  assert.equal(rerun.failure, null);
  assert.deepEqual(rerun.stores.map((s) => s.outcome), ['replayed', 'replayed']);
  assert.equal(rerun.storageSwitched, true);
  assert.equal(storageOf(work), 'sqlite');
  assert.equal(modeOf(work), 'work', 'moving back keeps the PR flow');
  assert.deepEqual([projectDb, domain].map((p) => buildManifest(snapshotSqliteStore(p)).manifest.digest), digests, 'the round trip left identical content');
  assert.equal(readSqliteFence(projectDb), null);
});

test('--dry-run fences nothing, copies nothing and leaves storage and mode', { skip: PG_SKIP }, () => {
  usedPg = true;
  const base = tempDir();
  const work = project(join(base, 'work'));
  const projectDb = join(work, '.sterling', 'sterling.db');
  seedStore(projectDb, { label: 'dry' });
  const report = runMoveStore({ root: work, to: 'pg', dryRun: true, registryDb: registry(base, [work]) });
  assert.equal(report.stores[0].outcome, 'dry_run');
  assert.equal(report.stores[0].dry_run_plan, 'copy into a new store');
  assert.equal(readSqliteFence(projectDb), null);
  assert.equal(storageOf(work), undefined);
  assert.equal(modeOf(work), 'work');
  assert.match(formatReport(report), /dry run/);
});

test('credentials file mode is checked before any connection', () => {
  const base = tempDir();
  const work = project(join(base, 'work'));
  const creds = join(base, 'served.json');
  writeFileSync(creds, '{}');
  chmodSync(creds, 0o644);
  assert.throws(() => runMoveStore({ root: work, to: 'pg', credentialsPath: creds, registryDb: join(base, 'r.db') }), (e) => e.name === 'MoveCredentialsError' && e.message.includes('mode'));
});

test('--attach: machine B, a fresh clone of a project machine A moved, joins it and reads A\'s records; a local store with records needs --fence-local', { skip: PG_SKIP }, () => {
  usedPg = true;
  const base = tempDir();
  const domainA = join(base, 'a-domains', 'attachdom.db');
  const seededDomain = seedStore(domainA, { label: 'attach-domain' });
  const a = project(join(base, 'machine-a'), { stack: ['attachdom'], domainPaths: { attachdom: domainA } });
  const seededProject = seedStore(join(a, '.sterling', 'sterling.db'), { label: 'attach-project' });
  assert.equal(runMoveStore({ root: a, to: 'pg', registryDb: registry(base, [a]) }).failure, null);

  // Machine B: the committed project.json, its own gitignored config with no storage key, and a local store holding a record.
  const b = join(base, 'machine-b');
  mkdirSync(join(b, '.sterling'), { recursive: true });
  writeFileSync(join(b, '.sterling', 'project.json'), readFileSync(join(a, '.sterling', 'project.json')));
  writeFileSync(join(b, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', stack_tags: ['attachdom'], domain_paths: { attachdom: join(base, 'b-domains', 'attachdom.db') } }, null, 2));
  const local = join(b, '.sterling', 'sterling.db');
  seedStore(local, { label: 'machine-b' });

  assert.throws(() => runAttach({ root: b }), (e) => e.name === 'MoveAttachError' && e.check === 'local_store' && e.message.includes('--fence-local'));
  assert.equal(storageOf(b), undefined);
  assert.equal(readSqliteFence(local), null);

  const dry = runAttach({ root: b, dryRun: true, fenceLocal: true });
  assert.match(formatAttachReport(dry), /\(dry run\)[\s\S]*would be fenced[\s\S]*config\.storage not changed \(dry run\)/);
  assert.equal(storageOf(b), undefined);

  const report = runAttach({ root: b, fenceLocal: true });
  const text = formatAttachReport(report);
  assert.deepEqual(report.stores.map((s) => s.identity.kind), ['project', 'domain']);
  assert.match(text, /no data is copied/);
  assert.match(text, /config\.storage switched to postgres/);
  assert.match(text, /config\.mode unchanged \(work\)/);
  assert.equal(storageOf(b), 'postgres');
  assert.equal(modeOf(b), 'work');
  assert.ok(readSqliteFence(local), 'machine B\'s own SQLite store is fenced');
  assert.equal(existsSync(join(base, 'b-domains', 'attachdom.db')), false, 'no domain file is created or touched');

  // The router on machine B now reaches machine A's records.
  const routed = openRoutedStores(b, { mount: true });
  try {
    assert.equal(routed.route.storage, 'postgres');
    assert.ok(routed.stores.get(seededProject.ids[0]), 'a project record written on machine A');
    assert.ok(routed.stores.get(seededDomain.ids[0]), 'a domain record written on machine A');
  } finally {
    routed.stores.close();
  }
  assert.throws(() => runAttach({ root: b }), (e) => e.name === 'MoveAttachError' && e.check === 'storage');
});
