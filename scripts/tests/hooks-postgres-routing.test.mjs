// Hooks, the subject fan, the duty reads and the selection slot route through
// @sterling/store/routing (issue Chulf58/sterling#26 item 5c; decision
// storage-backend-is-its-own-config-key-written-only-by-store-move).
//
// A project whose config.storage is 'postgres' is never "not a Sterling
// project": with the database unreachable the blocking hook (H10) fails closed
// naming the error, every advisory hook prints a named DEGRADED line, and no
// SQLite file is created anywhere under .sterling/. SQLite storage keeps its
// behaviour (every other hook suite covers it; the store-backend cases below
// pin the decision itself). The live arm (STERLING_TEST_PG=1) runs the hooks
// against Served under its own sterling_test_<random> namespace, dropped after.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PgBridge, SterlingStore, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { isSterlingRoot, storeBackend } from '../hooks/lib/store-backend.mjs';
import { projectRoot } from '../hooks/lib/common.mjs';
import { isSterlingProject } from '../hooks/lib/plan-lock.mjs';
import { describeMountedDomains, openSubjectFan } from '../hooks/lib/subject-fan.mjs';
import { openDutyRecords } from '../hooks/lib/session-duties.mjs';
import { selectionFilePath, takeSelectionFile, writeSelectionFile } from '../hooks/lib/selection-file.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(repo, 'scripts', 'hooks');
const PG_SKIP = process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-pg-hooks-${label}-`));
  dirs.push(d);
  return d;
};

function project(config, identity) {
  const root = tempDir('project');
  mkdirSync(join(root, '.sterling'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  if (identity !== undefined) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: identity }));
  return root;
}

const pgConfig = (stack_tags = []) => ({ mode: 'work', storage: 'postgres', stack_tags });

function homeWith(creds) {
  const home = tempDir('home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const path = join(home, '.sterling', 'credentials', 'served.json');
  writeFileSync(path, JSON.stringify(creds));
  chmodSync(path, 0o600);
  return home;
}

const UNREACHABLE = { host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 };

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** No SQLite store file was created anywhere under .sterling/. */
function assertNoSqlite(root) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.startsWith('sterling.db')) found.push(join(d, e.name));
    }
  };
  walk(join(root, '.sterling'));
  assert.deepEqual(found, [], 'Postgres storage must never create a SQLite store');
}

// ---------------------------------------------------------------------------
// The backend decision and the project anchor (pure, no database)
// ---------------------------------------------------------------------------

test('storeBackend: absent or sqlite storage is today\'s SQLite open; postgres and unknown values route; an unreadable config keeps an existing SQLite file', () => {
  const none = tempDir('none');
  assert.equal(storeBackend(none), 'sqlite', 'no config at all');
  assert.equal(storeBackend(project({})), 'sqlite');
  assert.equal(storeBackend(project({ storage: 'sqlite' })), 'sqlite');
  assert.equal(storeBackend(project({ storage: 'postgres' })), 'routed');
  assert.equal(storeBackend(project({ storage: 'pg' })), 'routed', 'the router refuses an invalid value by name');
  const brokenWithDb = project({});
  writeFileSync(join(brokenWithDb, '.sterling', 'config.json'), '{ not json');
  writeFileSync(join(brokenWithDb, '.sterling', 'sterling.db'), '');
  assert.equal(storeBackend(brokenWithDb), 'sqlite', 'an existing SQLite file keeps today\'s open');
  const brokenNoDb = project({});
  writeFileSync(join(brokenNoDb, '.sterling', 'config.json'), '{ not json');
  assert.equal(storeBackend(brokenNoDb), 'routed', 'no file to fall back on: the router names the bad config');
});

test('projectRoot, isSterlingRoot and plan-lock isSterlingProject anchor on .sterling/config.json and still accept .sterling/sterling.db; a bare .sterling directory is not a project', () => {
  const configOnly = project(pgConfig(), randomUUID());
  const deep = join(configOnly, 'src', 'deeper');
  mkdirSync(deep);
  assert.equal(projectRoot(deep), configOnly);
  assert.equal(isSterlingProject(configOnly), true);

  const dbOnly = tempDir('dbonly');
  mkdirSync(join(dbOnly, '.sterling'));
  writeFileSync(join(dbOnly, '.sterling', 'sterling.db'), '');
  assert.equal(isSterlingRoot(dbOnly), true);
  assert.equal(isSterlingProject(dbOnly), true);

  // ~/.sterling shape: domains and a registry, no config.json and no sterling.db at its root.
  const homeLike = tempDir('homelike');
  mkdirSync(join(homeLike, '.sterling', 'domains', 'node'), { recursive: true });
  writeFileSync(join(homeLike, '.sterling', 'registry.db'), '');
  assert.equal(isSterlingRoot(homeLike), false);
  assert.equal(isSterlingProject(homeLike), false);
  assert.equal(projectRoot(join(homeLike, '.sterling', 'domains')), null);
});

// ---------------------------------------------------------------------------
// Database unreachable: blocking fails closed, advisory degrades by name
// ---------------------------------------------------------------------------

test('H10 (blocking Stop gate), Postgres storage, database unreachable: exit 2 naming StoreUnreachableError and failing closed; writes no store', () => {
  const root = project(pgConfig(), randomUUID());
  const r = runHook('h10-direct-capture.mjs', { hook_event_name: 'Stop', cwd: root, session_id: 's-pg', stop_hook_active: false }, root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /H10: the project store could not be opened \(StoreUnreachableError: storage 'postgres': the Postgres store database at 127\.0\.0\.1:1\/app is unreachable/);
  assert.match(r.stderr, /Failing closed/);
  assert.doesNotMatch(r.stderr, /not-a-secret/);
  assertNoSqlite(root);
});

test('H10, Postgres storage, database unreachable, re-entered Stop (stop_hook_active): releases loudly with exit 1 and the named error, never traps the session', () => {
  const root = project(pgConfig(), randomUUID());
  const r = runHook('h10-direct-capture.mjs', { hook_event_name: 'Stop', cwd: root, session_id: 's-pg', stop_hook_active: true }, root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /StoreUnreachableError/);
  assert.match(r.stderr, /Released because this Stop was already blocked once/);
  assertNoSqlite(root);
});

test('H10, Postgres storage, no identity file: fails closed naming ProjectIdentityError', () => {
  const root = project(pgConfig());
  const r = runHook('h10-direct-capture.mjs', { hook_event_name: 'Stop', cwd: root, session_id: 's-pg', stop_hook_active: false }, root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /ProjectIdentityError: storage 'postgres' needs the project identity file/);
  assertNoSqlite(root);
});

const ADVISORY = [
  ['H7', 'h7-file-touch.mjs', (root) => ({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'a.mjs'), new_string: 'x' } })],
  ['H16', 'h16-event-register.mjs', (root) => ({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'WebSearch', tool_input: { query: 'postgres hooks' } })],
  ['H19', 'h19-bash-delivery.mjs', (root) => ({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'node src/a.mjs' } })],
  ['H19', 'h19-knowledge-delivery.mjs', (root) => ({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'a.mjs') } })],
  ['H23', 'h23-output-axis.mjs', (root) => ({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'node build.mjs' }, tool_response: 'the hook routing output' })],
];

for (const [who, script, payload] of ADVISORY) {
  test(`${script} (advisory), Postgres storage, database unreachable: exit 1 with one named '${who}: DEGRADED' line; writes no store`, () => {
    const root = project(pgConfig(), randomUUID());
    const r = runHook(script, payload(root), root, { HOME: homeWith(UNREACHABLE) });
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`^${who}: DEGRADED — the project store could not be opened, so this hook did nothing this time \\(StoreUnreachableError: storage 'postgres'`, 'm'));
    assertNoSqlite(root);
  });
}

test('h1-session-start (advisory), Postgres storage, database unreachable: exit 0 with a DEGRADED line naming StoreUnreachableError in systemMessage and context; writes no store', () => {
  const root = project(pgConfig(), randomUUID());
  const r = runHook('h1-session-start.mjs', { hook_event_name: 'SessionStart', cwd: root, session_id: 's-pg', source: 'startup' }, root, { HOME: homeWith(UNREACHABLE), STERLING_NO_BANNER: '1' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /Sterling store: DEGRADED — the project store could not be opened \(StoreUnreachableError: storage 'postgres'/);
  assert.match(out.hookSpecificOutput.additionalContext, /DEGRADED .*StoreUnreachableError/);
  assertNoSqlite(root);
});

test('h20-mechanism-axis (advisory), Postgres storage, database unreachable: the delivery failure names the unreachable Postgres store; writes no store', () => {
  const root = project(pgConfig(), randomUUID());
  const r = runHook('h20-mechanism-axis.mjs', { hook_event_name: 'PreToolUse', cwd: root, session_id: 's-pg', tool_name: 'Agent', tool_input: { subagent_type: 'implementor', prompt: 'Fix the routing in src/a.mjs and add a test.' } }, root, { HOME: homeWith(UNREACHABLE) });
  assert.notEqual(r.code, 2, 'an advisory hook never blocks');
  assert.match(r.stderr, /H20: .*storage 'postgres': the Postgres store database at 127\.0\.0\.1:1\/app is unreachable/);
  assertNoSqlite(root);
});

test('h19-dispatch-staging (advisory), Postgres storage, database unreachable: staging fails by name and the return contract still ships; writes no store', () => {
  const root = project(pgConfig(), randomUUID());
  const r = runHook('h19-dispatch-staging.mjs', { hook_event_name: 'SubagentStart', cwd: root, session_id: 's-pg', agent_id: 'a-1', agent_type: 'implementor' }, root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /H19: dispatch staging failed: storage 'postgres': the Postgres store database at 127\.0\.0\.1:1\/app is unreachable/);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /STERLING DEFAULT RETURN CONTRACT/);
  assertNoSqlite(root);
});

// ---------------------------------------------------------------------------
// Library arms, database unreachable
// ---------------------------------------------------------------------------

function withHome(home, fn) {
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = before;
  }
}

test('subject fan, Postgres storage, database unreachable: openSubjectFan throws StoreUnreachableError (never null, never a project-only fan)', () => {
  const root = project(pgConfig(['alpha']), randomUUID());
  withHome(homeWith(UNREACHABLE), () => {
    assert.throws(() => openSubjectFan(root), (e) => e.name === 'StoreUnreachableError');
  });
  assertNoSqlite(root);
});

test('describeMountedDomains, Postgres storage, database unreachable: every configured domain is unreadable with the named error, none is missing or skipped', () => {
  const root = project(pgConfig(['alpha', 'beta']), randomUUID());
  const described = withHome(homeWith(UNREACHABLE), () => describeMountedDomains(pgConfig(['alpha', 'beta']), { root }));
  assert.deepEqual(described.map((d) => [d.name, d.state]), [['alpha', 'unreadable'], ['beta', 'unreadable']]);
  for (const d of described) assert.match(d.error, /^StoreUnreachableError: storage 'postgres'/);
  assert.throws(() => describeMountedDomains(pgConfig(['alpha'])), /project root is required/);
});

test('openDutyRecords, Postgres storage, database unreachable: each configured domain is reported unreadable by name and counts as holding nothing', () => {
  const root = project(pgConfig(['alpha']), randomUUID());
  const reported = [];
  const projectStore = { query: () => [] };
  const records = withHome(homeWith(UNREACHABLE), () => {
    const r = openDutyRecords(projectStore, pgConfig(['alpha']), { root, onUnreadable: (name, error) => reported.push([name, error]), onLedgerUnreadable: () => {} });
    assert.deepEqual(r.query({ types: ['decision'] }), []);
    return r;
  });
  assert.equal(reported.length, 1);
  assert.equal(reported[0][0], 'alpha');
  assert.match(reported[0][1], /^StoreUnreachableError: storage 'postgres'/);
  assert.deepEqual(records.close(), []);
  assertNoSqlite(root);
});

// ---------------------------------------------------------------------------
// The selection slot on Postgres storage
// ---------------------------------------------------------------------------

test('selection slot, Postgres storage: H2 takes the host-local file one-shot without connecting (the credentials point at nothing)', () => {
  const root = project(pgConfig(), randomUUID());
  writeSelectionFile(root, 'decision', 'rec-1', '2026-10-06T00:00:00.000Z');
  assert.match(selectionFilePath(root), /\.sterling\/transient\/selection\.[^/]+\.json$/);
  const home = homeWith(UNREACHABLE);
  const first = runHook('h2-selection-inject.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'hi' }, root, { HOME: home });
  assert.equal(first.code, 0, first.stderr);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /the user has selected decision 'rec-1'/);
  assert.equal(existsSync(selectionFilePath(root)), false, 'taken one-shot');
  const second = runHook('h2-selection-inject.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'again' }, root, { HOME: home });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, '');
  assertNoSqlite(root);
});

test('selection slot, Postgres storage: a slot that is not a selection is removed and H2 reports it by name instead of reading "nothing selected"', () => {
  const root = project(pgConfig(), randomUUID());
  mkdirSync(join(root, '.sterling', 'transient'), { recursive: true });
  writeFileSync(selectionFilePath(root), '{"type": 1}');
  const r = runHook('h2-selection-inject.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'hi' }, root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^H2: DEGRADED — the TUI selection slot .* could not be read \(it is not \{type, record_id, at\}\)/m);
  assert.equal(existsSync(selectionFilePath(root)), false);
  assert.equal(takeSelectionFile(root), undefined);
});

test('selection slot, SQLite storage: H2 still consumes the store row and ignores a stray slot file', () => {
  const root = project({});
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  store.writeSelection('decision', 'rec-sqlite', '2026-10-06T00:00:00.000Z');
  store.close();
  writeSelectionFile(root, 'decision', 'rec-file', '2026-10-06T00:00:00.000Z');
  const r = runHook('h2-selection-inject.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'hi' }, root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /'rec-sqlite'/);
  assert.equal(existsSync(selectionFilePath(root)), true, 'the SQLite path never reads the file');
});

// ---------------------------------------------------------------------------
// Live arm: Served, under a sterling_test_ namespace
// ---------------------------------------------------------------------------

test('live Postgres storage: hooks open the routed store, deliver from it and write the project transient files; no SQLite store is created', { skip: PG_SKIP }, async () => {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const id = randomUUID();
  const bridge = new PgBridge(readPgCredentials());
  const env = { STERLING_TEST_PG_NAMESPACE: ns };
  try {
    ensurePgLayout(bridge, `${ns}_meta`);
    createPgStore(bridge, { kind: 'test', name: id, schema: `${ns}_p_${id.replace(/-/g, '')}`, metaSchema: `${ns}_meta` });
    createPgStore(bridge, { kind: 'test', name: 'alpha', schema: `${ns}_d_alpha`, metaSchema: `${ns}_meta` });
    const root = project(pgConfig(['alpha']), id);

    // Seed one owning article through the router, as the MCP server would.
    const prev = process.env.STERLING_TEST_PG_NAMESPACE;
    process.env.STERLING_TEST_PG_NAMESPACE = ns;
    try {
      const { store } = openRoutedStores(root);
      try {
        const now = new Date().toISOString();
        store.create(
          {
            id: randomUUID(), type: 'feature_article', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
            slug: 'routing-probe', title: 'Routing probe article', what_it_does: 'x', intended_behavior: 'x', files: [{ path: 'src/a.mjs', role: 'impl' }],
            current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [{ date: now, event: 'seed' }], live_test_refs: [],
          },
          { operation_id: randomUUID() },
        );
      } finally {
        store.close();
      }
      // The TUI opens the same project through the router and hands a selection
      // to the host-local slot, not to the shared store's row.
      const { openDashboard } = await import(pathToFileURL(join(repo, 'packages', 'tui', 'dist', 'controller.js')).href);
      const ctl = openDashboard(join(root, '.sterling', 'sterling.db'));
      try {
        assert.equal(ctl.stores.domainNames().join(','), 'alpha');
        await ctl.applyEffects([{ type: 'select', recordType: 'feature_article', id: 'tui-pick' }]);
        assert.equal(ctl.store.takeSelection(), undefined, 'the shared store row stays empty');
      } finally {
        ctl.close();
      }
      assert.equal(JSON.parse(readFileSync(selectionFilePath(root), 'utf8')).record_id, 'tui-pick');
    } finally {
      if (prev === undefined) delete process.env.STERLING_TEST_PG_NAMESPACE;
      else process.env.STERLING_TEST_PG_NAMESPACE = prev;
    }

    const h7 = runHook('h7-file-touch.mjs', ADVISORY[0][2](root), root, env);
    assert.equal(h7.code, 0, h7.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.sterling', 'transient', 'touches.json'), 'utf8')).map((t) => t.path), ['src/a.mjs']);

    const h19 = runHook('h19-knowledge-delivery.mjs', ADVISORY[3][2](root), root, env);
    assert.equal(h19.code, 0, h19.stderr);
    assert.match(JSON.parse(h19.stdout).hookSpecificOutput.additionalContext, /▸ article 'routing-probe'/);

    const h1 = runHook('h1-session-start.mjs', { hook_event_name: 'SessionStart', cwd: root, session_id: 's-live', source: 'startup' }, root, { ...env, STERLING_NO_BANNER: '1' });
    assert.equal(h1.code, 0, h1.stderr);
    assert.doesNotMatch(h1.stdout, /DEGRADED/);
    assert.match(JSON.parse(h1.stdout).hookSpecificOutput.additionalContext, /Mounted domain 'alpha' has NO description/);

    const h2 = runHook('h2-selection-inject.mjs', { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'hi' }, root, env);
    assert.equal(h2.code, 0, h2.stderr);
    assert.match(JSON.parse(h2.stdout).hookSpecificOutput.additionalContext, /selected feature_article 'tui-pick'/);

    const h10 = runHook('h10-direct-capture.mjs', { hook_event_name: 'Stop', cwd: root, session_id: 's-live', stop_hook_active: true }, root, env);
    assert.notEqual(h10.code, 2, h10.stderr);
    assert.doesNotMatch(h10.stderr, /could not be opened/);
    assertNoSqlite(root);
  } finally {
    try {
      const rows = bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows;
      for (const row of rows) bridge.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
    } finally {
      bridge.close();
    }
  }
});
