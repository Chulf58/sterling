// Multi-session toolkit slice 5: `--item <board item id>` on wake-project and notify-project routes a message to
// the session holding the item's claim (scripts/lib/claim-route.mjs, scripts/lib/owner-session.mjs deliver).
// Ported from CH.Hub's claim-routing tests where the behaviour is kept (see the omissions in the slice report):
// the claim read is a fake dependency (deps.readClaim) on the fake world of wake-notify-project.test.mjs; the
// real reader is tested against temp stores at the end. Hazard ddf7ad45: OPENCODE vars are cleared by the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';
import { world, readOwner } from './lib/multi-session-world.mjs';
import { main as wakeMain } from '../wake-project.mjs';
import { main as notifyMain, noticeText } from '../notify-project.mjs';
import { realClaimReader } from '../lib/claim-route.mjs';

const ITEM = 'abc12345';
const FULL = `${ITEM}-0000-4000-8000-000000000001`;
const TEXT = 'hello';

const held = (w, extra = {}) => ({ state: 'held', id: FULL, holder_session: 'ses_LANE', checkout: w.WT, generation: 4, ...extra });
const expired = (w) => held(w, { state: 'expired' });
const free = () => ({ state: 'none', id: FULL });
const summary = (c) => ({ item: ITEM, state: c.state, ...(c.state === 'held' || c.state === 'expired' ? { holder_session: c.holder_session, checkout: c.checkout, generation: c.generation } : {}) });

// The target project: an idle owner of the main checkout and an idle session ses_LANE in the session worktree.
async function ready() {
  const w = world();
  w.session('ses_OWN');
  w.session('ses_LANE', { dir: w.WT });
  await w.setOwner(w.ROOT, 'ses_OWN');
  return w;
}

// Installs a fake claim reader: `answer` is a claim, a function (request, number of the read) -> claim, or an Error to throw.
function claims(w, answer) {
  w.reads = [];
  w.readClaim = (req) => {
    w.reads.push(req);
    w.calls.push('claim');
    const out = typeof answer === 'function' ? answer(req, w.reads.length) : answer;
    if (out instanceof Error) throw out;
    return out;
  };
  return w;
}
const deps = (w, over) => w.deps({ ...(w.readClaim ? { readClaim: w.readClaim } : {}), ...over });
async function notify(w, extra = [], over) {
  const { io, json, out } = w.io();
  const code = await notifyMain(['--project', 'proj', '--text', TEXT, '--item', ITEM, ...extra], deps(w, over), io);
  return { code, res: json()[0], out };
}
async function wake(w, extra = [], over) {
  const { io, json, out } = w.io();
  const code = await wakeMain(['--project', 'proj', '--item', ITEM, ...extra], deps(w, over), io);
  return { code, res: json()[0], out };
}
const paths = (w) => w.posts.map((p) => p.path);

test('notify --item: a held claim sends the notice to its holder in the holder\'s checkout, not the owner; the owner record is untouched', async () => {
  const w = await ready();
  try {
    claims(w, held(w));
    const r = await notify(w);
    assert.equal(r.code, 0, r.out.stderr);
    assert.equal(r.res.status, 'queued');
    assert.equal(r.res.session, 'ses_LANE');
    assert.equal(r.res.checkout, w.WT);
    assert.deepEqual(r.res.claim, summary(held(w)));
    assert.deepEqual(paths(w), ['/api/session/ses_LANE/prompt']);
    assert.equal(w.posts[0].body.text, noticeText('sender', TEXT));
    assert.equal(readOwner(w.ROOT).session, 'ses_OWN');
    assert.equal(w.reads.length, 2, 'once to choose, once right before the send');
    assert.ok(w.reads.every((q) => q.root === w.ROOT && q.ref === ITEM));
    assert.deepEqual(w.journalRecords().map((j) => [j.state, j.checkout, j.session]), [['delivered', w.WT, 'ses_LANE']]);
  } finally {
    w.cleanup();
  }
});

test('--item: a holder in the main checkout that is not the recorded owner gets the message, and no owner record is written or needed', async () => {
  const w = world();
  try {
    w.session('ses_OWN');
    w.session('ses_MAINH');
    await w.setOwner(w.ROOT, 'ses_OWN');
    claims(w, held(w, { holder_session: 'ses_MAINH', checkout: w.ROOT }));
    const r = await wake(w);
    assert.equal(r.res.status, 'queued', JSON.stringify(r.res));
    assert.equal(r.res.session, 'ses_MAINH');
    assert.equal(readOwner(w.ROOT).session, 'ses_OWN');
    // A checkout with no recorded owner at all still takes a message for its claim holder.
    const x = world();
    try {
      x.session('ses_LANE', { dir: x.WT });
      claims(x, held(x));
      assert.equal((await notify(x)).res.status, 'queued');
    } finally {
      x.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('--item: no claim, or an expired one, goes to the owner exactly as without --item, and the answer says which it was', async () => {
  const plain = await ready();
  let base;
  try {
    const { io, json } = plain.io();
    await notifyMain(['--project', 'proj', '--text', TEXT], plain.deps(), io);
    base = json()[0];
  } finally {
    plain.cleanup();
  }
  for (const make of [free, expired]) {
    const w = await ready();
    try {
      const answer = make(w);
      claims(w, answer);
      const r = await notify(w);
      assert.equal(r.code, 0, r.out.stderr);
      const { claim, item, id, ...rest } = r.res;
      const { id: baseId, ...baseRest } = base;
      assert.deepEqual(rest, baseRest);
      assert.equal(item, ITEM);
      assert.deepEqual(claim, summary(answer));
      assert.deepEqual(paths(w), ['/api/session/ses_OWN/prompt']);
      assert.equal(w.reads.length, 2, 'a claim that routes nothing is read again right before the send');
    } finally {
      w.cleanup();
    }
  }
});

test('without --item no claim is read and behaviour is unchanged', async () => {
  const w = await ready();
  try {
    claims(w, held(w));
    const { io, json } = w.io();
    assert.equal(await notifyMain(['--project', 'proj', '--text', TEXT], deps(w), io), 0);
    assert.equal(json()[0].session, 'ses_OWN');
    assert.deepEqual(w.reads, []);
  } finally {
    w.cleanup();
  }
});

test('--item: a holder with an open form, a permission request or queued input waits as holder_busy_form; nothing sent', async () => {
  for (const setup of [
    (w) => w.forms.push({ sessionID: 'ses_LANE', dir: w.WT }),
    (w) => w.perms.push({ sessionID: 'ses_LANE', dir: w.WT }),
    (w) => w.inbox.set('ses_LANE', [{ id: 'msg_q', type: 'user', payload: { text: 'later' } }]),
  ]) {
    const w = await ready();
    try {
      setup(w);
      claims(w, held(w));
      for (const run of [notify, wake]) {
        const r = await run(w);
        assert.equal(r.code, 1);
        assert.deepEqual([r.res.status, r.res.reason, r.res.sent, r.res.session], ['refused', 'holder_busy_form', 'none', 'ses_LANE']);
        assert.match(r.res.why, /nothing sent/);
      }
      assert.deepEqual(w.posts, []);
    } finally {
      w.cleanup();
    }
  }
});

test('--item: a holder running a turn is busy and a second live conductor of its checkout makes a wake ambiguous; the owner is never tried', async () => {
  const w = await ready();
  try {
    claims(w, held(w));
    w.active.add('ses_LANE');
    assert.equal((await wake(w)).res.reason, 'busy');
    w.active.clear();
    w.session('ses_LANE2', { dir: w.WT });
    w.active.add('ses_LANE2');
    assert.equal((await wake(w)).res.reason, 'ambiguous_session');
    assert.deepEqual(w.posts, []);
  } finally {
    w.cleanup();
  }
});

test('--item: a held claim whose holder is gone, archived, a subagent, not a conductor, in another checkout or in a folder that is no checkout is holder_missing, never the owner', async () => {
  const cases = [
    ['gone', (w) => held(w, { holder_session: 'ses_GONE' })],
    ['archived', (w) => { w.session('ses_OLD', { dir: w.WT, archived: true }); return held(w, { holder_session: 'ses_OLD' }); }],
    ['a subagent', (w) => { w.session('ses_SUB', { dir: w.WT, parent: 'ses_LANE' }); return held(w, { holder_session: 'ses_SUB' }); }],
    ['not a conductor', (w) => { w.session('ses_WORKER', { dir: w.WT, agent: 'sterling/maintenance-worker' }); return held(w, { holder_session: 'ses_WORKER' }); }],
    ['in another checkout than the claim names', (w) => held(w, { holder_session: 'ses_OWN' })],
    ['claimed from a folder that is no checkout', (w) => held(w, { checkout: w.OTHER })],
    ['claimed from a relative path', (w) => held(w, { checkout: 'proj.worktrees/lane' })],
  ];
  for (const [what, make] of cases) {
    const w = await ready();
    try {
      claims(w, make(w));
      for (const run of [notify, wake]) {
        const r = await run(w);
        assert.equal(r.code, 1, what);
        assert.deepEqual([r.res.status, r.res.reason, r.res.sent], ['refused', 'holder_missing', 'none'], what);
        assert.match(r.res.why, /claim/, what);
      }
      assert.deepEqual(w.posts, [], what);
    } finally {
      w.cleanup();
    }
  }
});

test('--item: a claim that cannot be read, an item that is not on the board and an id that matches two items are refused, nothing sent', async () => {
  const w = await ready();
  try {
    const cases = [
      [Object.assign(new Error('timed out after 3000 ms'), { code: 'timeout' }), 'claim_unreadable', /timed out/],
      [{ state: 'not_found' }, 'item_not_found', /not on proj's board/],
      [{ state: 'ambiguous', matches: [`${ITEM}-a`, `${ITEM}-b`] }, 'item_ambiguous', /-b/],
      [{ state: 'held', id: FULL }, 'claim_unreadable', /unusable shape/],
      [{ state: 'bogus', id: FULL }, 'claim_unreadable', /unusable shape/],
    ];
    for (const [answer, reason, why] of cases) {
      claims(w, answer);
      for (const run of [notify, wake]) {
        const r = await run(w);
        assert.deepEqual([r.code, r.res.status, r.res.reason, r.res.sent], [1, 'refused', reason, 'none'], reason);
        assert.match(r.res.why, why);
      }
    }
    assert.deepEqual(w.posts, []);
  } finally {
    w.cleanup();
  }
});

// The claim changes between the first read and the one right before the send.
const CHANGES = [
  ['a new generation of the holder', (w) => [held(w), held(w, { generation: 5 })]],
  ['another holder', (w) => [held(w), held(w, { holder_session: 'ses_OTHER' })]],
  ['another checkout of the holder', (w) => [held(w), held(w, { checkout: w.ROOT })]],
  ['released', (w) => [held(w), free()]],
  ['ended', (w) => [held(w), expired(w)]],
  ['no claim, then held', (w) => [free(), held(w)]],
  ['expired, then renewed by the same session', (w) => [expired(w), held(w)]],
  ['expired, then taken by another session', (w) => [expired(w), held(w, { holder_session: 'ses_OTHER', generation: 5 })]],
  ['the item reference now names another item', (w) => [free(), { ...free(), id: `${ITEM}-0000-4000-8000-000000000002` }]],
  ['the held item reference now names another item', (w) => [held(w), held(w, { id: `${ITEM}-0000-4000-8000-000000000002` })]],
];
test('--item: a claim that changed between the read and the send is claim_changed, for the holder route and the owner route, notify and wake', async (t) => {
  for (const [what, make] of CHANGES) {
    await t.test(what, async () => {
      for (const run of [notify, wake]) {
        const w = await ready();
        try {
          const [before, after] = make(w);
          claims(w, (_req, n) => (n === 1 ? before : after));
          const r = await run(w);
          assert.deepEqual([r.code, r.res.status, r.res.reason, r.res.sent], [1, 'refused', 'claim_changed', 'none'], what);
          assert.match(r.res.why, /changed after it was read/);
          assert.deepEqual(r.res.claim, summary(before), 'the answer names the claim as it was first read');
          assert.deepEqual(w.posts, []);
          assert.equal(w.reads.length, 2);
          assert.match(w.journalRecords()[0].why, /^not sent: claim_changed/);
          assert.equal(w.journalRecords()[0].state, 'failed');
        } finally {
          w.cleanup();
        }
      }
    });
  }
});

test('--item: a renewed claim keeps the same generation and the same item, so an unchanged claim still sends', async () => {
  const w = await ready();
  try {
    claims(w, (_req, n) => held(w, { renewed_at: `2026-10-28T10:0${n}:00.000Z` }));
    assert.equal((await notify(w)).res.status, 'queued');
  } finally {
    w.cleanup();
  }
});

test('--item: a claim that cannot be read the second time stops the send, whether it was held, expired or free', async () => {
  for (const first of [held, expired, free]) {
    const w = await ready();
    try {
      claims(w, (_req, n) => (n === 1 ? first(w) : Object.assign(new Error('timed out'), { code: 'timeout' })));
      const r = await notify(w);
      assert.deepEqual([r.code, r.res.reason, r.res.sent], [1, 'claim_unreadable', 'none']);
      assert.deepEqual(w.posts, []);
    } finally {
      w.cleanup();
    }
  }
});

test('--item: the claim is re-read synchronously after the closing activity read and right before the POST, with no await between', async () => {
  for (const run of [notify, wake]) {
    const w = await ready();
    try {
      claims(w, held(w));
      assert.equal((await run(w)).res.status, 'queued');
      const post = w.calls.indexOf('POST');
      const last = w.calls.lastIndexOf('claim');
      assert.equal(last, post - 1, 'nothing is called between the claim re-read and the POST');
      assert.equal(w.calls[last - 1], 'GET /api/session/active', 'the closing activity read comes right before the claim re-read');
      assert.equal(w.reads.length, 2);
    } finally {
      w.cleanup();
    }
  }
});

test('--item: a claim taken while the closing activity request is awaited stops the POST', async () => {
  const w = await ready();
  try {
    let journaled = false;
    let seenActive = 0;
    claims(w, (_req, n) => (n === 1 || !journaled ? held(w) : held(w, { generation: 9 })));
    w.onGet = async (path) => {
      if (path === '/api/session/active' && ++seenActive >= 3) journaled = true;
    };
    const r = await wake(w);
    assert.equal(r.res.reason, 'claim_changed', JSON.stringify(r.res));
    assert.deepEqual(w.posts, []);
  } finally {
    w.cleanup();
  }
});

test('--item --dry-run names the holder and sends, journals and locks nothing', async () => {
  const w = await ready();
  try {
    let locked = 0;
    claims(w, held(w));
    const r = await notify(w, ['--dry-run'], { runLock: async () => { locked += 1; return async () => {}; } });
    assert.deepEqual([r.res.status, r.res.session, r.res.sent, r.res.checkout], ['would_queue', 'ses_LANE', 'none', w.WT]);
    assert.deepEqual(w.posts, []);
    assert.equal(w.journalRecords().length, 0);
    assert.equal(locked, 0);
  } finally {
    w.cleanup();
  }
});

test('--item: the run lock is taken on the holder\'s checkout, not the main one', async () => {
  const w = await ready();
  try {
    const keys = [];
    claims(w, held(w));
    await wake(w, [], { runLock: async (key) => { keys.push(key); return async () => {}; } });
    assert.deepEqual(keys, [w.WT]);
  } finally {
    w.cleanup();
  }
});

test('--item: a target with multi_session off refuses before any claim is read', async () => {
  const w = await ready();
  try {
    w.multi.set(w.ROOT, false);
    claims(w, held(w));
    const r = await notify(w);
    assert.equal(r.res.reason, 'multi_session_off');
    assert.deepEqual(w.reads, []);
  } finally {
    w.cleanup();
  }
});

test('wake --item: the prompt names the item and a wake of another item is not the same message', async () => {
  const w = await ready();
  try {
    claims(w, held(w));
    assert.equal((await wake(w)).res.status, 'queued');
    assert.match(w.posts[0].body.text, new RegExp(`board item ${ITEM}`));
    assert.equal(w.journalRecords()[0].body, `wake item ${ITEM}`);
  } finally {
    w.cleanup();
  }
});

test('--item: bad arguments exit 2 before any claim read or call', async () => {
  const w = await ready();
  try {
    claims(w, held(w));
    const bad = [
      [notifyMain, ['--all', '--text', TEXT, '--item', ITEM]],
      [notifyMain, ['--project', 'proj', '--text', TEXT, '--item', ITEM, '--checkout', w.WT]],
      [notifyMain, ['--project', 'proj', '--text', TEXT, '--item', 'not an id']],
      [notifyMain, ['--project', 'proj', '--text', TEXT, '--item']],
      [notifyMain, ['--project', 'proj', '--text', TEXT, '--item', '--dry-run']],
      [wakeMain, ['--project', 'proj', '--item', ITEM, '--checkout', w.WT]],
      [wakeMain, ['--project', 'proj', '--item', 'not an id']],
      [wakeMain, ['--project', 'proj', '--item']],
      [wakeMain, ['--set-owner', '--project', 'proj', '--session', 'ses_OWN', '--item', ITEM]],
      [wakeMain, ['--show-owners', '--item', ITEM]],
    ];
    for (const [main, argv] of bad) {
      const { io, json } = w.io();
      assert.equal(await main(argv, deps(w), io), 2, argv.join(' '));
      assert.equal(json().at(-1).status, 'failed');
    }
    assert.deepEqual([w.reads, w.calls.filter((c) => c !== 'claim')], [[], []]);
    const { io, json } = w.io();
    assert.equal(await notifyMain([], deps(w), io), 2);
    assert.match(json()[0].error, /--item <board item id>/);
  } finally {
    w.cleanup();
  }
});

// --- the real reader, on temp stores (the machine's live stores are never read) ---

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

function target({ lease, config, claimAgeMinutes, free: unclaimed } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'claim-route-'));
  const root = join(base, 'proj');
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), config ?? JSON.stringify(lease ? { board_claims: { lease_minutes: lease } } : {}));
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  let id;
  let slug;
  try {
    const tools = new SterlingTools({ store, repoRoot: root, now: () => minutesAgo(claimAgeMinutes ?? 0) });
    const rec = tools.boardAdd({ text: 'the task\nsecond line', source: 'user', objective: 'standalone' }).record;
    id = rec.id;
    slug = rec.slug;
    if (!unclaimed) store.claimTodo(id, { session: 'ses_H', checkout: '/c/lane', now: minutesAgo(claimAgeMinutes ?? 0) });
  } finally {
    store.close();
  }
  return { root, id, slug, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const dirBytes = (dir) => Object.fromEntries(readdirSync(dir).filter((n) => !n.endsWith('-shm')).sort().map((n) => [n, readFileSync(join(dir, n))]));

test('real reader: a claim is held or expired by the TARGET project\'s own lease, and a free item is none', () => {
  const short = target({ lease: 60, claimAgeMinutes: 90 });
  const long = target({ lease: 120, claimAgeMinutes: 90 });
  const none = target({ free: true });
  try {
    const a = realClaimReader({ root: short.root, ref: short.id, now: NOW });
    assert.deepEqual([a.state, a.id, a.holder_session, a.checkout], ['expired', short.id, 'ses_H', '/c/lane']);
    assert.ok(Number.isInteger(a.generation));
    const b = realClaimReader({ root: long.root, ref: long.id.slice(0, 8), now: NOW });
    assert.deepEqual([b.state, b.id, b.holder_session], ['held', long.id, 'ses_H']);
    assert.deepEqual(realClaimReader({ root: none.root, ref: none.id, now: NOW }), { state: 'none', id: none.id });
    if (long.slug) assert.equal(realClaimReader({ root: long.root, ref: long.slug, now: NOW }).id, long.id, 'a slug names the item too');
  } finally {
    short.cleanup();
    long.cleanup();
    none.cleanup();
  }
});

test('real reader: an unknown item is not_found; an unreadable config, a missing store and a missing folder throw, never read as none', () => {
  const t = target({ lease: 60, claimAgeMinutes: 1 });
  const bad = target({ config: '{ not json', free: true });
  try {
    assert.deepEqual(realClaimReader({ root: t.root, ref: 'ffffffff', now: NOW }), { state: 'not_found' });
    assert.throws(() => realClaimReader({ root: bad.root, ref: bad.id, now: NOW }), /malformed|JSON/i);
    assert.throws(() => realClaimReader({ root: join(t.root, 'nowhere'), ref: t.id, now: NOW }), /does not exist/);
    rmSync(join(t.root, '.sterling', 'sterling.db'));
    assert.throws(() => realClaimReader({ root: t.root, ref: t.id, now: NOW }), /no board store/);
  } finally {
    t.cleanup();
    bad.cleanup();
  }
});

test('real reader: it writes nothing and renews nothing', () => {
  const t = target({ lease: 60, claimAgeMinutes: 90 });
  try {
    const before = dirBytes(join(t.root, '.sterling'));
    realClaimReader({ root: t.root, ref: t.id, now: NOW });
    assert.deepEqual(dirBytes(join(t.root, '.sterling')), before);
  } finally {
    t.cleanup();
  }
});
