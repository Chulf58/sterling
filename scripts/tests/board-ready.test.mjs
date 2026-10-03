// The board readiness lines (decision
// board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start): the
// shared lib (scripts/hooks/lib/board-ready.mjs) that H1, H20 and the OpenCode
// plugin render from store.boardReadiness().
//   H1:  three groups READY / READY FOR RESEARCH / WAITING ON YOU, cap 8 each,
//        priority then updated_at, write-path overlap marks among READY items,
//        and 'live lanes k/<delegation.max_concurrent>'.
//   H20: one 'BOARD READY: ...' line, deduped per session on a hash of the
//        full READY + RESEARCH id set (taken before any brief filter).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
let lib;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  lib = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'board-ready.mjs')).href);
});

function project(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-ready-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

function mk(store, over) {
  const at = over.updated_at ?? '2026-10-03T12:00:00.000Z';
  return store.create({
    id: randomUUID(), type: 'todo', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], source: 'user', ...over,
  });
}
const h = (text, rec) => `${text} (${rec.id.slice(0, 8)})`;

test('renderBoardReadiness: three groups in order, needs shown on WAITING, blocked items left out, live lanes k/N', () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Ready one', slug: 'ready-one' });
    const r = mk(p.store, { text: 'Research one', needs: 'investigation' });
    const w = mk(p.store, { text: 'Grill one', needs: 'grill' });
    mk(p.store, { text: 'Blocked one', blocked_by: ['ready-one'] });
    const wb = mk(p.store, { text: 'Grill after ready', needs: 'grill', blocked_by: ['ready-one'] });
    const text = lib.renderBoardReadiness({ readiness: p.store.boardReadiness(), live: { count: 2, availability: 'ok' }, ceiling: { value: 5 } });
    const lines = text.split('\n');
    assert.match(lines[0], /^BOARD READINESS .*live lanes 2\/5/);
    assert.ok(lines[0].includes('1 blocked'), lines[0]);
    const iReady = lines.indexOf('READY (1):');
    const iRes = lines.indexOf('READY FOR RESEARCH (1, researcher lanes only):');
    const iWait = lines.indexOf('WAITING ON YOU (2):');
    assert.ok(iReady > 0 && iRes > iReady && iWait > iRes, text);
    assert.equal(lines[iReady + 1], `- ${h('Ready one', a)}`);
    assert.equal(lines[iRes + 1], `- ${h('Research one', r)}`);
    const waitLines = lines.slice(iWait + 1, iWait + 3);
    assert.ok(waitLines.includes(`- ${h('Grill one', w)} — needs grill`), text);
    assert.ok(waitLines.includes(`- ${h('Grill after ready', wb)} — needs grill (also blocked by ${h('Ready one', a)})`), 'a waiting item with open blockers says so');
    assert.ok(!text.includes('Blocked one'));
    assert.ok(!text.includes('ready-one'), 'no bare slug is printed');
  } finally {
    p.cleanup();
  }
});

test('renderBoardReadiness: cap 8 per group with the remainder disclosed; priority then updated_at', () => {
  const p = project();
  try {
    const recs = [];
    for (let i = 0; i < 10; i++) recs.push(mk(p.store, { text: `Item ${i}`, updated_at: `2026-10-0${1 + (i % 9)}T00:00:0${i % 10}.000Z` }));
    const hi = mk(p.store, { text: 'Urgent', priority: 'high', updated_at: '2026-01-01T00:00:00.000Z' });
    const text = lib.renderBoardReadiness({ readiness: p.store.boardReadiness(), live: { count: 0, availability: 'ok' }, ceiling: { value: 5 } });
    const lines = text.split('\n');
    const i = lines.indexOf('READY (11):');
    assert.equal(lines[i + 1], `- ${h('Urgent', hi)} [high]`, 'high priority first even though oldest');
    const items = lines.slice(i + 1).filter((l) => l.startsWith('- '));
    assert.equal(items.length, 8);
    assert.ok(lines.includes('  … 3 more READY (board_query)'), text);
  } finally {
    p.cleanup();
  }
});

test('renderBoardReadiness: READY items sharing a file_keys path are marked with each other', () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Alpha', file_keys: ['scripts/hooks/h1-session-start.mjs'] });
    const b = mk(p.store, { text: 'Beta', file_keys: ['scripts/hooks/h1-session-start.mjs', 'x.ts'] });
    mk(p.store, { text: 'Gamma', file_keys: ['y.ts'] });
    const text = lib.renderBoardReadiness({ readiness: p.store.boardReadiness(), live: { count: 0, availability: 'ok' }, ceiling: { value: 5 } });
    assert.ok(text.includes(`- ${h('Alpha', a)} ⚠ shares a write path with ${h('Beta', b)}`), text);
    assert.ok(text.includes(`- ${h('Beta', b)} ⚠ shares a write path with ${h('Alpha', a)}`), text);
    assert.ok(/- Gamma \([0-9a-f]{8}\)$/m.test(text), text);
  } finally {
    p.cleanup();
  }
});

test('renderBoardReadiness: an empty board renders nothing; an unreadable register or ceiling says so', () => {
  const p = project();
  try {
    assert.equal(lib.renderBoardReadiness({ readiness: [], live: { count: 0, availability: 'ok' }, ceiling: { value: 5 } }), '');
    mk(p.store, { text: 'One' });
    const text = lib.renderBoardReadiness({ readiness: p.store.boardReadiness(), live: { count: 0, availability: 'corrupt' }, ceiling: { error: 'bad key' } });
    assert.match(text.split('\n')[0], /live lanes \? \(dispatch register corrupt\)\/\? \(delegation\.max_concurrent unreadable: bad key\)/);
  } finally {
    p.cleanup();
  }
});

test('laneCeiling: reads delegation.max_concurrent, falling to the schema default when absent', () => {
  assert.deepEqual(lib.laneCeiling({ delegation: { max_concurrent: 3 } }), { value: 3 });
  assert.deepEqual(lib.laneCeiling({}), { value: 5 });
  assert.deepEqual(lib.laneCeiling(null), { value: 5 });
  assert.ok(lib.laneCeiling({ delegation: { max_concurrent: 0 } }).error);
});

test('boardReadyNotice: READY and RESEARCH items, minus those the brief names by id8 or slug; the hash ignores the brief', () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Alpha', slug: 'alpha' });
    const b = mk(p.store, { text: 'Beta' });
    const r = mk(p.store, { text: 'Probe', needs: 'investigation' });
    mk(p.store, { text: 'Ask', needs: 'user' });
    const all = lib.boardReadyNotice(p.store.boardReadiness(), 'unrelated brief', { count: 1, availability: 'ok' }, { value: 4 });
    assert.ok(all.line.includes(h('Alpha', a)) && all.line.includes(h('Beta', b)), all.line);
    const n = lib.boardReadyNotice(p.store.boardReadiness(), 'implement alpha now', { count: 1, availability: 'ok' }, { value: 4 });
    assert.equal(
      n.line,
      `BOARD READY: ${h('Beta', b)}, ${h('Probe', r)} [research] — live lanes 1/4; fill free lanes up to the ceiling (a ceiling, never a quota).`,
      'the item the brief names by slug is the one being dispatched and is left out'
    );
    const named = lib.boardReadyNotice(p.store.boardReadiness(), `dispatch for board item ${b.id.slice(0, 8)} and slug alpha`, { count: 0, availability: 'ok' }, { value: 4 });
    assert.ok(!named.line.includes('Beta') && !named.line.includes('Alpha'), named.line);
    assert.ok(named.line.includes('Probe'));
    assert.equal(named.hash, n.hash, 'the same ready set hashes the same whatever the brief names');
    assert.equal(named.hash, all.hash);
    const none = lib.boardReadyNotice([], 'x', { count: 0, availability: 'ok' }, { value: 4 });
    assert.equal(none, null);
  } finally {
    p.cleanup();
  }
});

test('boardReadyNotice: an unchanged ready set is shown once across dispatches with different briefs; a changed set re-fires', () => {
  const p = project();
  try {
    mk(p.store, { text: 'Alpha', slug: 'alpha' });
    mk(p.store, { text: 'Probe', needs: 'investigation' });
    mk(p.store, { text: 'Ask', needs: 'user' });
    const live = { count: 0, availability: 'ok' };
    const dispatch = (brief) => {
      const n = lib.boardReadyNotice(p.store.boardReadiness(), brief, live, { value: 4 });
      if (!n || !lib.boardReadyNoticeDue(p.dir, 's-dedupe', n.hash)) return null;
      lib.markBoardReadyNoticed(p.dir, 's-dedupe', n.hash);
      return n;
    };
    assert.ok(dispatch('first unrelated brief'), 'the first dispatch shows the line');
    assert.equal(dispatch('a second, different brief'), null, 'same ready set, different brief: silent');
    assert.equal(dispatch('implement alpha now'), null, 'a brief naming an item does not change the set either');
    assert.equal(dispatch('a fourth brief entirely'), null);
    const added = mk(p.store, { text: 'Gamma' });
    const again = dispatch('fifth brief');
    assert.ok(again && again.line.includes(h('Gamma', added)), 'a new ready item changes the set and the line fires again');
    assert.equal(dispatch('sixth brief'), null);
  } finally {
    p.cleanup();
  }
});

test('boardReadyNotice: an item named in a live dispatch description is not listed; the hash still covers it', () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Alpha', slug: 'alpha' });
    const b = mk(p.store, { text: 'Beta' });
    const base = lib.boardReadyNotice(p.store.boardReadiness(), 'x', { count: 0, availability: 'ok' }, { value: 4 });
    const live = { count: 1, availability: 'ok', descriptions: [`implement ${a.id.slice(0, 8)} slice`, 'unrelated lane'] };
    const n = lib.boardReadyNotice(p.store.boardReadiness(), 'x', live, { value: 4 });
    assert.ok(!n.line.includes('Alpha') && n.line.includes(h('Beta', b)), n.line);
    assert.equal(n.hash, base.hash);
    const slugLive = { count: 1, availability: 'ok', descriptions: ['do alpha'] };
    assert.ok(!lib.boardReadyNotice(p.store.boardReadiness(), 'x', slugLive, { value: 4 }).line.includes('Alpha'), 'a slug in the description counts too');
    const allLive = { count: 2, availability: 'ok', descriptions: [`${a.id.slice(0, 8)}`, `${b.id.slice(0, 8)}`] };
    assert.equal(lib.boardReadyNotice(p.store.boardReadiness(), 'x', allLive, { value: 4 }), null, 'everything is already in flight: no line');
  } finally {
    p.cleanup();
  }
});

test('liveLanes: carries the descriptions of the live lanes, joined from dispatch-state through tool_use_id', async () => {
  const p = project();
  try {
    const reg = await import(pathToFileURL(join(root, 'scripts', 'lib', 'dispatch-register.mjs')).href);
    assert.deepEqual(lib.liveLanes(p.dir, 's-live'), { availability: 'ok', count: 0, descriptions: [] }, 'no register yet: zero lanes');
    await reg.recordDispatchPre(p.dir, { tool_use_id: 'toolu_live1', session_id: 's-live', tool_input: { subagent_type: 'implementor', description: 'build alpha slice', prompt: 'work' } });
    await reg.registerStart(p.dir, { agent_id: 'ag1', agent_type: 'implementor', session_id: 's-live', files: [], tool_use_id: 'toolu_live1', at: new Date().toISOString() });
    await reg.registerStart(p.dir, { agent_id: 'ag2', agent_type: 'implementor', session_id: 's-live', files: [], tool_use_id: null, at: new Date().toISOString() });
    const live = lib.liveLanes(p.dir, 's-live');
    assert.equal(live.count, 2);
    assert.deepEqual(live.descriptions, ['build alpha slice'], 'a lane with no state record contributes no description');
    assert.equal(lib.liveLanes(p.dir, 's-other').count, 0, 'another session holds no lanes of this one');
  } finally {
    p.cleanup();
  }
});

test('boardReadyNoticeDue / markBoardReadyNoticed: once per session per ready-set hash', () => {
  const p = project();
  try {
    assert.equal(lib.boardReadyNoticeDue(p.dir, 's1', 'h1'), true);
    lib.markBoardReadyNoticed(p.dir, 's1', 'h1');
    assert.equal(lib.boardReadyNoticeDue(p.dir, 's1', 'h1'), false, 'same session, same set: silent');
    assert.equal(lib.boardReadyNoticeDue(p.dir, 's1', 'h2'), true, 'the ready set changed: due again');
    assert.equal(lib.boardReadyNoticeDue(p.dir, 's2', 'h1'), true, 'a new session: due again');
  } finally {
    p.cleanup();
  }
});

test('H1 end to end: the board readiness block reaches additionalContext', () => {
  const p = project({ delegation: { max_concurrent: 3 } });
  try {
    const a = mk(p.store, { text: 'Ready via H1', slug: 'ready-via-h1' });
    mk(p.store, { text: 'Needs the user', needs: 'user' });
    mk(p.store, { text: 'Needs grill behind a blocker', needs: 'grill', blocked_by: ['ready-via-h1'] });
    p.store.close();
    const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
      input: JSON.stringify({ session_id: 'sess-board-ready', cwd: p.dir, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir },
      timeout: 120_000,
    });
    assert.equal(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /BOARD READINESS .*live lanes 0\/3/);
    assert.ok(ctx.includes(`- ${h('Ready via H1', a)}`), ctx.slice(0, 2000));
    assert.ok(ctx.includes('WAITING ON YOU (2):'), ctx.slice(0, 2500));
    assert.ok(ctx.includes(`— needs grill (also blocked by ${h('Ready via H1', a)})`), 'a blocked grill item still waits, with its blocker named');
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('H20 end to end: one BOARD READY line on an Agent dispatch, silent on the repeat even with a different brief', () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Ready via H20' });
    p.store.close();
    const run = (prompt = 'unrelated work') =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'hooks', 'h20-mechanism-axis.mjs')], {
        input: JSON.stringify({ session_id: 'sess-h20-ready', cwd: p.dir, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementor', prompt } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir },
        timeout: 60_000,
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const ctx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    const line = ctx.split('\n').find((l) => l.startsWith('BOARD READY:'));
    assert.ok(line && line.includes(h('Ready via H20', a)), ctx);
    for (const prompt of ['unrelated work', 'a different brief', 'yet another brief']) {
      const again = run(prompt);
      assert.equal(again.status, 0, again.stderr);
      assert.ok(!again.stdout.includes('BOARD READY'), `deduped for the same session and ready set (${prompt})`);
    }
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

// ---- OpenCode parity (packages/opencode-plugin/src/context.mjs) ----------------
// Root sessions only; never inside the maintenance worker's child (anti-pattern
// e40bf982); no agent-name comparison is involved (anti-pattern 217fa6ca).
async function ocHandler(p, { parentID, env = {} } = {}) {
  const contextMod = await import(pathToFileURL(join(root, 'packages', 'opencode-plugin', 'src', 'context.mjs')).href);
  const session = { get: async ({ sessionID }) => ({ id: sessionID, ...(parentID ? { parentID } : {}) }) };
  return contextMod.createContextHandler({
    openStore: (path) => new SterlingStore(path),
    now: () => '2026-10-03T12:00:00.000Z',
    rootOf: () => p.dir,
    fenced: async (_n, _r, fn) => fn(),
    rotationRestore: async () => '',
    sessionSync: async () => {},
    pluginRoot: join(p.dir, 'no-such-plugin-root'),
    getSession: () => session,
    env,
  });
}

async function ocText(handler, sessionID = 'ses_board') {
  const i = { sessionID, agent: 'sterling/conductor', system: [{ type: 'text', text: 'base' }], messages: [], tools: {} };
  await handler.onContext(i);
  return i.system.map((s) => s.text).join('\n');
}

async function ocContext(p, opts) {
  return ocText(await ocHandler(p, opts));
}

test('OpenCode: a root session context carries the board readiness block', async () => {
  const p = project({ delegation: { max_concurrent: 2 } });
  try {
    const a = mk(p.store, { text: 'Ready on OpenCode' });
    const text = await ocContext(p);
    assert.match(text, /BOARD READINESS .*live lanes 0\/2/);
    assert.ok(text.includes(`- ${h('Ready on OpenCode', a)}`), text.slice(-1500));
  } finally {
    p.cleanup();
  }
});

test('OpenCode: the maintenance worker child gets no board readiness block', async () => {
  const p = project();
  try {
    mk(p.store, { text: 'Ready on OpenCode' });
    const text = await ocContext(p, { env: { STERLING_MAINTENANCE_WORKER: '1' } });
    assert.ok(!text.includes('BOARD READINESS'), 'the worker child is not the conductor');
  } finally {
    p.cleanup();
  }
});

test('OpenCode: the readiness cache is per root but the live-lane count is per session', async () => {
  const p = project({ delegation: { max_concurrent: 4 } });
  try {
    mk(p.store, { text: 'Ready on OpenCode' });
    const reg = await import(pathToFileURL(join(root, 'scripts', 'lib', 'dispatch-register.mjs')).href);
    await reg.registerStart(p.dir, { agent_id: 'lane-a', agent_type: 'implementor', session_id: 'ses_a', files: [], tool_use_id: null, at: new Date().toISOString() });
    const handler = await ocHandler(p);
    assert.match(await ocText(handler, 'ses_b'), /live lanes 0\/4/, 'a session with no lanes');
    assert.match(await ocText(handler, 'ses_a'), /live lanes 1\/4/, 'inside the cache window another session still sees its own lane');
    assert.match(await ocText(handler, 'ses_b'), /live lanes 0\/4/, 'and the first session does not inherit it');
  } finally {
    p.cleanup();
  }
});
