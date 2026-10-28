// Multi-session toolkit slice 3: wake-project and notify-project deliveries (scripts/lib/owner-session.mjs
// admission and deliver, scripts/lib/delivery-journal.mjs). Ported from CH.Hub's wake-project, notify-project
// and per-checkout-owners tests where the behaviour is kept; the journal recovery tests are new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { world, readOwner, recordOwner } from './lib/multi-session-world.mjs';
import { main as wakeMain, wakeText } from '../wake-project.mjs';
import { main as notifyMain, noticeText } from '../notify-project.mjs';
import { deliveryJournal, journalPath, newMessageId } from '../lib/delivery-journal.mjs';

async function wake(w, argv = ['--project', 'proj'], over) {
  const { io, json, out } = w.io();
  const code = await wakeMain(argv, w.deps(over), io);
  return { code, res: json()[0], out };
}
async function notify(w, argv, over) {
  const { io, json, out } = w.io();
  const code = await notifyMain(argv, w.deps(over), io);
  return { code, all: json(), res: json()[0], out };
}
// A target project with an idle recorded owner.
async function ready() {
  const w = world();
  w.session('ses_OWN');
  await w.setOwner(w.ROOT, 'ses_OWN');
  return w;
}

test('idle owner: one queued prompt with the fixed text, a message id and delivery queue; the journal says delivered', async () => {
  const w = await ready();
  try {
    const { code, res } = await wake(w);
    assert.equal(code, 0);
    assert.equal(res.status, 'queued');
    assert.equal(res.sent, 'yes');
    assert.equal(w.posts.length, 1);
    const { path, body } = w.posts[0];
    assert.equal(path, '/api/session/ses_OWN/prompt');
    assert.deepEqual(Object.keys(body).sort(), ['delivery', 'id', 'text']);
    assert.equal(body.delivery, 'queue');
    assert.equal(body.text, wakeText('sender'));
    assert.match(body.id, /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    assert.equal(res.id, body.id);
    assert.deepEqual(w.journalRecords().map((r) => [r.id, r.state, r.kind, r.project, r.checkout, r.session]), [[body.id, 'delivered', 'wake', 'proj', w.ROOT, 'ses_OWN']]);
  } finally {
    w.cleanup();
  }
});

test('message ids ascend with the send time, so a prompt sorts where it was sent', () => {
  const a = newMessageId(1_700_000_000_000);
  const b = newMessageId(1_700_000_000_000);
  const c = newMessageId(1_700_000_000_001);
  assert.ok(a.slice(0, 16) < b.slice(0, 16) && b.slice(0, 16) < c.slice(0, 16));
});

test('a dry run reads and checks the same, sends nothing and writes no journal', async () => {
  const w = await ready();
  try {
    const { code, res } = await wake(w, ['--project', 'proj', '--dry-run']);
    assert.equal(code, 0);
    assert.equal(res.status, 'would_queue');
    assert.equal(w.posts.length, 0);
    assert.equal(w.journalRecords().length, 0);
    w.inbox.set('ses_OWN', [{ id: 'msg_x', type: 'user', payload: { text: 'hi' } }]);
    assert.equal((await wake(w, ['--project', 'proj', '--dry-run'])).res.reason, 'input_pending');
  } finally {
    w.cleanup();
  }
});

test('busy: the owner running a turn, or any subagent of its tree at any depth, refuses with nothing sent', async () => {
  const w = await ready();
  try {
    w.active.add('ses_OWN');
    let r = await wake(w);
    assert.equal(r.code, 1);
    assert.equal(r.res.reason, 'busy');
    w.active.clear();
    w.session('ses_KID', { parent: 'ses_OWN' });
    w.session('ses_GRAND', { parent: 'ses_KID' });
    w.active.add('ses_GRAND');
    r = await wake(w);
    assert.equal(r.res.reason, 'busy');
    assert.equal(r.res.sent, 'none');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('an open question form, a permission request (its subagent\'s too) or queued input refuses: input_pending', async () => {
  for (const setup of [
    (w) => w.forms.push({ sessionID: 'ses_OWN', dir: w.ROOT }),
    (w) => w.perms.push({ sessionID: 'ses_OWN', dir: w.ROOT }),
    (w) => { w.session('ses_KID', { parent: 'ses_OWN' }); w.forms.push({ sessionID: 'ses_KID', dir: w.ROOT }); },
    (w) => w.inbox.set('ses_OWN', [{ id: 'msg_q', type: 'user', payload: { text: 'later' } }]),
  ]) {
    const w = await ready();
    try {
      setup(w);
      const { code, res } = await wake(w);
      assert.equal(code, 1);
      assert.equal(res.reason, 'input_pending', JSON.stringify(res));
      assert.equal(w.posts.length, 0);
    } finally {
      w.cleanup();
    }
  }
});

test('inbox: a synthetic background shell notice alone is not queued input; beside a typed entry it is', async () => {
  const w = await ready();
  try {
    const shell = { id: 'msg_s', type: 'synthetic', payload: { text: 'done', metadata: { source: 'shell' } } };
    w.inbox.set('ses_OWN', [shell]);
    assert.equal((await wake(w)).res.status, 'queued');
    w.inbox.set('ses_OWN', [shell, { id: 'msg_u', type: 'user', payload: { text: 'x' } }]);
    assert.equal((await wake(w)).res.reason, 'input_pending');
  } finally {
    w.cleanup();
  }
});

test('a form of a session in another project does not block the wake', async () => {
  const w = await ready();
  try {
    w.session('ses_FAR', { dir: w.OTHER });
    w.forms.push({ sessionID: 'ses_FAR', dir: w.OTHER });
    assert.equal((await wake(w)).res.status, 'queued');
  } finally {
    w.cleanup();
  }
});

test('a running shell where the owner tree works refuses: its folder, an ended grandchild\'s folder, a removed folder with a live process', async () => {
  const lane = (w) => { w.session('ses_KID', { parent: 'ses_OWN', dir: w.WT }); w.session('ses_GRAND', { parent: 'ses_KID', dir: w.OTHER }); };
  for (const setup of [
    (w) => w.shells.set(w.ROOT, [{ id: 'shl_1', status: 'running' }]),
    (w) => { lane(w); w.shells.set(w.OTHER, [{ id: 'shl_2', status: 'running' }]); },
    (w) => { lane(w); w.removed.add(w.OTHER); w.processes.push({ pid: 4242, cwd: `${w.OTHER}/sub (deleted)` }); },
  ]) {
    const w = await ready();
    try {
      setup(w);
      const { code, res } = await wake(w);
      assert.equal(code, 1);
      assert.equal(res.reason, 'shell_running', JSON.stringify(res));
      assert.equal(w.posts.length, 0);
    } finally {
      w.cleanup();
    }
  }
  const w = await ready();
  try {
    w.shells.set(w.ROOT, [{ id: 'shl_old', status: 'exited' }]);
    assert.equal((await wake(w)).res.status, 'queued');
  } finally {
    w.cleanup();
  }
});

test('shells that cannot be established refuse: an unreadable list, a removed folder without a process reader', async () => {
  const w = await ready();
  try {
    w.shellError = new Set([w.ROOT]);
    assert.equal((await wake(w)).res.reason, 'unknown');
    w.shellError = null;
    w.session('ses_KID', { parent: 'ses_OWN', dir: w.OTHER });
    w.removed.add(w.OTHER);
    assert.equal((await wake(w, undefined, { processCwds: undefined })).res.reason, 'unknown');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('a second live conductor of the checkout makes a wake ambiguous; a notify still goes to the owner only', async () => {
  const w = await ready();
  try {
    w.session('ses_TWO');
    w.active.add('ses_TWO');
    const r = await wake(w);
    assert.equal(r.res.reason, 'ambiguous_session');
    assert.equal(w.posts.length, 0);
    const n = await notify(w, ['--project', 'proj', '--text', 'hello']);
    assert.equal(n.code, 0);
    assert.deepEqual(w.posts.map((p) => p.path), ['/api/session/ses_OWN/prompt']);
    assert.equal(w.posts[0].body.text, noticeText('sender', 'hello'));
  } finally {
    w.cleanup();
  }
});

test('no recorded owner: no_owner naming the --set-owner command; an unusable owner: owner_missing; nothing elects one', async () => {
  const w = world();
  try {
    w.session('ses_ANY');
    let r = await wake(w);
    assert.equal(r.res.reason, 'no_owner');
    assert.match(r.res.why, /--set-owner --project proj --session '<id>'/);
    for (const [id, opts] of [['ses_GONE', null], ['ses_KID', { parent: 'ses_ANY' }], ['ses_ARCH', { archived: true }], ['ses_WRK', { agent: 'sterling/implementor' }], ['ses_FAR', { dir: w.OTHER }]]) {
      if (opts) w.session(id, opts);
      await recordOwner(w.ROOT, id);
      r = await wake(w);
      assert.equal(r.res.reason, 'owner_missing', id);
    }
    assert.equal(w.posts.length, 0);
    assert.equal(readOwner(w.ROOT).session, 'ses_FAR');
  } finally {
    w.cleanup();
  }
});

test('multi_session off in the target refuses a delivery before any server read; a dry run still inspects', async () => {
  const w = await ready();
  try {
    w.multi.set(w.ROOT, false);
    const r = await wake(w);
    assert.equal(r.code, 1);
    assert.equal(r.res.reason, 'multi_session_off');
    assert.equal(w.calls.length, 0);
    assert.equal((await wake(w, ['--project', 'proj', '--dry-run'])).res.status, 'would_queue');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('--checkout: the wake goes to the checkout owner; a busy main owner does not block it, a busy checkout owner does not block the main', async () => {
  const w = await ready();
  try {
    w.session('ses_LANE', { dir: w.WT });
    await w.setOwner(w.WT, 'ses_LANE');
    w.active.add('ses_OWN');
    let r = await wake(w, ['--project', 'proj', '--checkout', w.WT]);
    assert.equal(r.res.status, 'queued');
    assert.equal(r.res.checkout, w.WT);
    assert.equal(w.posts[0].path, '/api/session/ses_LANE/prompt');
    w.active.clear();
    w.active.add('ses_LANE');
    r = await wake(w);
    assert.equal(r.res.status, 'queued');
    assert.equal(w.posts[1].path, '/api/session/ses_OWN/prompt');
    assert.equal(readOwner(w.ROOT).session, 'ses_OWN');
  } finally {
    w.cleanup();
  }
});

test('the owner record changing during the admission (a /new prompted there) sends nothing: owner_changed', async () => {
  const w = await ready();
  try {
    w.session('ses_NEW');
    w.onGet = async (path) => {
      if (path.startsWith('/api/shell')) {
        w.onGet = null;
        await recordOwner(w.ROOT, 'ses_NEW');
      }
    };
    const r = await wake(w);
    assert.equal(r.res.reason, 'owner_changed');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('final admission: the owner turning busy, a new subagent of it starting, or input arriving right before the POST sends nothing', async () => {
  const late = (w, fn) => {
    let reads = 0;
    w.onGet = async (path) => {
      if (path === '/api/session/active' && ++reads === 2) fn(w);
    };
  };
  for (const [fn, reason] of [
    [(w) => w.active.add('ses_OWN'), 'busy'],
    [(w) => w.active.add('ses_LATE'), 'busy'],
  ]) {
    const w = await ready();
    try {
      late(w, fn);
      const api = w.api;
      // ses_LATE starts after the snapshot: only a direct read finds its parent.
      const r = await wake(w, undefined, { api: async (m, p) => (p === '/api/session/ses_LATE' ? { code: 0, stdout: JSON.stringify({ data: { id: 'ses_LATE', parentID: 'ses_OWN' } }), stderr: '' } : api(m, p)) });
      assert.equal(r.res.reason, reason);
      assert.equal(w.posts.length, 0);
    } finally {
      w.cleanup();
    }
  }
  const w = await ready();
  try {
    let forms = 0;
    w.onGet = async (path) => {
      if (path.startsWith('/api/form') && ++forms === 2) w.inbox.set('ses_OWN', [{ id: 'msg_q', type: 'user', payload: { text: 'x' } }]);
    };
    assert.equal((await wake(w)).res.reason, 'input_pending');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('crash between the POST and the record: the next run finds the prompt in the session and sends nothing new', async () => {
  const w = await ready();
  try {
    // The prompt landed, then the run died: the journal still says sending.
    w.sendResult = (body, session) => { w.land(session, body); throw new Error('killed'); };
    const first = await wake(w);
    assert.equal(first.res.status, 'failed');
    assert.equal(first.res.sent, 'maybe');
    assert.deepEqual(w.journalRecords().map((r) => r.state), ['sending']);
    w.sendResult = null;
    const again = await wake(w);
    assert.equal(again.code, 0);
    assert.equal(again.res.status, 'delivered');
    assert.equal(again.res.reconciled, true);
    assert.equal(again.res.id, first.res.id);
    assert.equal(w.posts.length, 1);
    assert.deepEqual(w.journalRecords().map((r) => r.state), ['delivered']);
  } finally {
    w.cleanup();
  }
});

test('a prompt still queued in the inbox counts as its receipt', async () => {
  const w = await ready();
  try {
    w.sendResult = () => ({ ok: false, uncertain: true, why: 'timed out' });
    const first = await wake(w);
    assert.match(first.res.error, /may have been sent/);
    w.inbox.set('ses_OWN', [{ id: first.res.id, type: 'user', payload: { text: wakeText('sender') } }]);
    w.sendResult = null;
    const again = await wake(w);
    assert.equal(again.res.status, 'delivered');
    assert.equal(w.posts.length, 1);
  } finally {
    w.cleanup();
  }
});

test('an uncertain send that never landed is resent with the SAME message id after a full admission; the server keeps one message', async () => {
  const w = await ready();
  try {
    w.sendResult = () => ({ ok: false, uncertain: true, why: 'reset after send' });
    const first = await wake(w);
    assert.equal(first.res.sent, 'maybe');
    assert.deepEqual(w.journalRecords().map((r) => r.state), ['uncertain']);
    w.sendResult = null;
    w.active.add('ses_OWN');
    assert.equal((await wake(w)).res.reason, 'busy');
    assert.equal(w.posts.length, 1);
    w.active.clear();
    const again = await wake(w);
    assert.equal(again.res.status, 'queued');
    assert.equal(again.res.resent, true);
    assert.equal(w.posts.length, 2);
    assert.equal(w.posts[1].body.id, first.res.id);
    assert.equal(w.messages.get('ses_OWN').length, 1);
    const [rec] = w.journalRecords();
    assert.equal(rec.state, 'delivered');
    assert.equal(rec.attempts, 2);
  } finally {
    w.cleanup();
  }
});

test('a POST proven never sent is failed with sent none; a reply for another session or delivery is uncertain, sent maybe', async () => {
  const w = await ready();
  try {
    w.sendResult = () => ({ ok: false, uncertain: false, why: 'exit 1: connection refused' });
    let r = await wake(w);
    assert.equal(r.code, 1);
    assert.equal(r.res.sent, 'none');
    assert.equal(w.journalRecords()[0].state, 'failed');
    w.sendResult = (body) => ({ ok: true, data: { data: { id: body.id, sessionID: 'ses_ELSE', delivery: 'steer' } } });
    r = await wake(w);
    assert.equal(r.res.sent, 'maybe');
    assert.deepEqual(w.journalRecords().map((x) => x.state).sort(), ['failed', 'uncertain']);
  } finally {
    w.cleanup();
  }
});

test('an unresolved earlier delivery of another text blocks a new one; a pending one to a gone or replaced owner is abandoned', async () => {
  const w = await ready();
  try {
    w.sendResult = () => ({ ok: false, uncertain: true, why: 'timed out' });
    await notify(w, ['--project', 'proj', '--text', 'first']);
    w.sendResult = null;
    const blocked = await notify(w, ['--project', 'proj', '--text', 'second']);
    assert.equal(blocked.res.reason, 'unresolved_delivery');
    assert.equal(w.posts.length, 1);
    const same = await notify(w, ['--project', 'proj', '--text', 'first']);
    assert.equal(same.res.resent, true);
    assert.equal(w.posts[1].body.text, noticeText('sender', 'first'));
    // A pending prompt to an owner that was replaced is abandoned, and the new delivery goes on.
    w.sendResult = () => ({ ok: false, uncertain: true, why: 'timed out' });
    await notify(w, ['--project', 'proj', '--text', 'third']);
    w.sendResult = null;
    w.session('ses_NEW');
    await recordOwner(w.ROOT, 'ses_NEW');
    const next = await notify(w, ['--project', 'proj', '--text', 'fourth']);
    assert.equal(next.res.status, 'queued');
    assert.equal(w.journalRecords().find((r) => r.body === 'third').state, 'abandoned');
  } finally {
    w.cleanup();
  }
});

test('the journal refuses a torn file loudly, never sends blind, and never resends a settled record', async () => {
  const w = await ready();
  try {
    mkdirSync(dirname(journalPath(w.SENDER)), { recursive: true });
    writeFileSync(journalPath(w.SENDER), '{ torn');
    const r = await wake(w);
    assert.equal(r.res.status, 'failed');
    assert.match(r.res.error, /not valid JSON/);
    assert.equal(w.posts.length, 0);
    writeFileSync(journalPath(w.SENDER), JSON.stringify({ version: 1, records: {} }));
    const j = deliveryJournal(w.SENDER);
    await j.sending({ id: 'msg_1', kind: 'wake', project: 'proj', checkout: w.ROOT, session: 'ses_OWN' });
    await j.settle('msg_1', 'delivered');
    await assert.rejects(() => j.sending({ id: 'msg_1' }), /already delivered/);
    await assert.rejects(() => j.settle('msg_1', 'uncertain'), /already delivered/);
  } finally {
    w.cleanup();
  }
});

test('a server error on a read, or an unknown project, sends nothing; an unknown project is exit 2', async () => {
  const w = await ready();
  try {
    const r = await wake(w, undefined, { api: async (m, p) => (p === '/api/session/active' ? { code: 1, stdout: '', stderr: 'HTTP 500 Internal Server Error' } : w.api(m, p)) });
    assert.equal(r.code, 1);
    assert.equal(w.posts.length, 0);
    const u = await wake(w, ['--project', 'nope']);
    assert.equal(u.code, 2);
    assert.equal(u.res.sent, 'none');
  } finally {
    w.cleanup();
  }
});

test('notify --all: one queued prompt per other project with an owner and multi_session on; the rest skipped; one line each', async () => {
  const w = await ready();
  try {
    w.session('ses_FAR', { dir: w.OTHER });
    await w.setOwner(w.OTHER, 'ses_FAR');
    w.registry.push({ name: 'quiet', repo_path: w.base });
    const n = await notify(w, ['--all', '--text', 'heads up'], { cwd: w.SENDER });
    assert.equal(n.code, 0);
    assert.deepEqual(n.all.map((r) => [r.project, r.status]).sort(), [['other', 'queued'], ['proj', 'queued'], ['quiet', 'skipped']]);
    assert.deepEqual(w.posts.map((p) => p.path).sort(), ['/api/session/ses_FAR/prompt', '/api/session/ses_OWN/prompt']);
    w.active.add('ses_FAR');
    const partial = await notify(w, ['--all', '--text', 'again']);
    assert.equal(partial.code, 1);
    assert.equal(partial.all.find((r) => r.project === 'other').reason, 'busy');
  } finally {
    w.cleanup();
  }
});

test('notify: bad arguments exit 2 before any call; a text may start with dashes', async () => {
  const w = await ready();
  try {
    for (const argv of [[], ['--project', 'proj'], ['--all', '--project', 'proj', '--text', 'x'], ['--all', '--checkout', w.WT, '--text', 'x'], ['--project', 'proj', '--text', '--dry-run'], ['--project', 'proj', '--text', '   ']]) {
      assert.equal((await notify(w, argv)).code, 2, argv.join(' '));
    }
    assert.equal(w.calls.length, 0);
    const r = await notify(w, ['--project', 'proj', '--text', '--not-a-flag']);
    assert.equal(r.res.status, 'queued');
    assert.equal(w.posts[0].body.text, noticeText('sender', '--not-a-flag'));
  } finally {
    w.cleanup();
  }
});
