import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, likelyReset, readProjectInventory, readProjectInventories, readSessionSnapshot, topLevelSessionsAt, parseGitWorktrees, STALE_SUBAGENT_NOTICE_MS, Fail } from '../lib/session-inventory.mjs';

const ROOT = '/work/proj';
const WT = '/work/proj.worktrees/branch';
const NOW = 100_000_000;
const row = (id, dir = ROOT, parentID = null) => ({ id, parentID, location: { directory: dir }, time: { created: 1, updated: NOW } });

function machine() {
  const rows = [row('ses_owner'), row('ses_extra', WT), row('ses_child', '/elsewhere', 'ses_extra')];
  const w = { rows, active: { ses_child: {} }, forms: [], perms: [], inbox: {}, calls: [] };
  const deps = {
    now: () => NOW,
    realpath: async (p) => p, readdir: async (dir) => (dir === '/work/proj.worktrees' ? ['branch'] : []), gitWorktrees: async () => [ROOT, WT],
    api: async (method, path) => {
      assert.equal(method, 'GET');
      w.calls.push(path);
      let data;
      const url = new URL(path, 'http://fake');
      if (url.pathname === '/api/session/active') data = w.active;
      else if (url.pathname === '/api/session') data = url.searchParams.has('cursor') ? [] : rows.filter((s) => url.searchParams.has('parentID') ? (url.searchParams.get('parentID') === 'null' ? s.parentID == null : s.parentID === url.searchParams.get('parentID')) : !url.searchParams.has('directory') || s.location.directory === url.searchParams.get('directory'));
      else if (url.pathname === '/api/form') data = w.forms.filter((f) => rows.find((s) => s.id === f.sessionID)?.location.directory === url.searchParams.get('location[directory]'));
      else if (url.pathname === '/api/permission/request') data = w.perms.filter((f) => rows.find((s) => s.id === f.sessionID)?.location.directory === url.searchParams.get('location[directory]'));
      else if (path.endsWith('/inbox')) data = w.inbox[path.split('/')[3]] ?? [];
      else data = rows.find((s) => s.id === path.split('/')[3]);
      return { code: 0, stdout: JSON.stringify({ data, cursor: { next: 'next' } }) };
    },
  };
  return { w, deps, scan: async () => (await readProjectInventory({ ...deps }, REGISTRY, 'proj')).live };
}

// One conductor per checkout: the inventory places each conductor in the checkout it runs in and carries that on its entry.
const S2 = '/work/proj.worktrees/session-2';
const S3 = '/work/proj.worktrees/session-3';
function checkoutMachine(extraRows = [], { registered = [S2, S3], folders = ['session-2', 'session-3'] } = {}) {
  const m = machine();
  m.w.rows.length = 0;
  m.w.rows.push(row('ses_owner'), row('ses_s2', S2), row('ses_s3', S3), ...extraRows);
  m.w.active = {};
  m.w.gitCalls = [];
  m.deps.readdir = async (dir) => (dir === '/work/proj.worktrees' ? folders : []);
  m.deps.gitWorktrees = async (root) => {
    m.w.gitCalls.push(root);
    return [ROOT, ...registered];
  };
  return m;
}
test('inventory maps active children to the worktree top-level parent and lists each folder once', async () => {
  const { w, scan } = machine();
  assert.deepEqual(await scan(), [{ id: 'ses_extra', dir: WT, busy: false, why: ['its subagent ses_child is busy'], checkout: WT }]);
  assert.equal(w.calls.filter((p) => p === `/api/form?location%5Bdirectory%5D=${encodeURIComponent(WT)}`).length, 1);
});

test('inventory includes turns, forms, permissions and queued input without shell notices', async () => {
  const { w, scan } = machine();
  w.active.ses_extra = {};
  w.forms = [{ sessionID: 'ses_extra' }];
  w.perms = [{ sessionID: 'ses_extra' }];
  w.inbox.ses_extra = [{ type: 'user' }];
  w.inbox.ses_owner = [{ type: 'synthetic', payload: { metadata: { source: 'shell' } } }];
  const [extra] = await scan();
  assert.equal(extra.busy, true);
  assert.deepEqual(new Set(extra.why), new Set(['busy', 'its subagent ses_child is busy', 'a question form is open', 'a permission request is open', 'input is already queued']));
});

test('inventory ignores only old verified completed-subagent notices', async () => {
  const { w, scan } = machine();
  w.active = {};
  w.rows[1].time.updated = NOW - STALE_SUBAGENT_NOTICE_MS;
  w.inbox.ses_extra = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', state: 'completed', childID: 'ses_child' } } }];
  assert.deepEqual(await scan(), []);
  w.rows[1].time.updated++;
  assert.equal((await scan())[0].id, 'ses_extra');
});

test('inventory leaves the project unknown, never empty, on a malformed active id or a parent loop', async () => {
  const { w, deps } = machine();
  const read = () => readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.equal((await read()).unknown, undefined, 'the fixture is healthy');
  w.active = { invalid: {} };
  assert.equal((await read()).unknown, true);
  w.active = { ses_child: {} };
  w.rows[2].parentID = 'ses_child';
  w.rows[2].location.directory = ROOT;
  assert.equal((await read()).unknown, true);
});

test('complete session snapshot fails loud on an unusable cursor', async () => {
  const { deps } = machine();
  const api = deps.api;
  deps.api = async (method, path) => {
    const result = await api(method, path);
    if (path === '/api/session?limit=1000') result.stdout = JSON.stringify({ data: [row('ses_child', '/elsewhere', 'ses_extra')] });
    return result;
  };
  await assert.rejects(() => readSessionSnapshot(deps), /no usable cursor/);
});


test('quiet top-level sessions in worktree subdirectories are included', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows.push(row('ses_subdir', `${WT}/subdir`));
  w.forms = [{ sessionID: 'ses_subdir' }];
  const inventory = await readProjectInventory({ ...deps }, [{ name: 'proj', repo_path: ROOT }], 'proj');
  assert.deepEqual(inventory.live, [{ id: 'ses_subdir', dir: `${WT}/subdir`, busy: false, why: ['a question form is open'], checkout: WT }]);
});

test('maintenance workers are neither inventoried nor reported as extra conductors; no-agent sessions count', async () => {
  const { w, deps } = machine();
  const worker = { ...row('ses_worker'), agent: 'sterling-maintenance-worker' };
  w.rows.push(worker, row('ses_workerchild', ROOT, 'ses_worker'));
  w.active = { ses_worker: {}, ses_workerchild: {}, ses_owner: {} };
  w.forms = [{ sessionID: 'ses_worker' }, { sessionID: 'ses_workerchild' }];
  const inventory = await readProjectInventory({ ...deps }, [{ name: 'proj', repo_path: ROOT }], 'proj');
  assert.deepEqual(inventory.live.map((s) => s.id), ['ses_owner']);
});

test('a maintenance worker owner entry does not suppress the no-owner reporting threshold', async () => {
  const { w, deps } = machine();
  w.rows.push({ ...row('ses_worker'), agent: 'sterling-maintenance-worker' });
  const inventory = await readProjectInventory({ ...deps }, [{ name: 'proj', repo_path: ROOT }], 'proj', 'ses_worker');
  assert.equal(inventory.owner, undefined);
});


const REGISTRY = [{ name: 'proj', repo_path: ROOT }];
test('snapshot follows a short page to quiet child requests on its successor', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.forms = [{ sessionID: 'ses_child' }];
  const api = deps.api;
  deps.api = async (method, path) => {
    if (path === '/api/session?limit=1000') return { code: 0, stdout: JSON.stringify({ data: [w.rows[0]], cursor: { next: 'short' } }) };
    if (path === '/api/session?limit=1000&cursor=short') return { code: 0, stdout: JSON.stringify({ data: w.rows.slice(1), cursor: { next: 'end' } }) };
    if (path === '/api/session?limit=1000&cursor=end') return { code: 0, stdout: '{"data":[]}' };
    return api(method, path);
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, [{ id: 'ses_extra', dir: WT, busy: false, why: ['its subagent ses_child: a question form is open'], checkout: WT }]);
});

test('an incomplete snapshot is an error rather than a successful empty inventory', async () => {
  const { deps } = machine();
  const api = deps.api;
  deps.api = async (method, path) => path.includes('cursor=') ? { code: 1, stderr: 'HTTP 503 Unavailable' } : api(method, path);
  await assert.rejects(() => readSessionSnapshot(deps), /503/);
});

test('old queued user input stays live in the snapshot without an age cutoff', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows[1].time.updated = 1;
  w.inbox.ses_extra = [{ type: 'user' }];
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, [{ id: 'ses_extra', dir: WT, busy: false, why: ['input is already queued'], checkout: WT }]);
});

test('a possibly live child in a missing folder and an active session missing from the snapshot stay unknown', async () => {
  const { w, deps } = machine();
  deps.realpath = async (path) => {
    if (path === '/elsewhere') throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  assert.equal((await readProjectInventory({ ...deps }, REGISTRY, 'proj')).unknown, true);
  w.active = { ses_new: {} };
  assert.equal((await readProjectInventory({ ...deps }, REGISTRY, 'proj')).unknown, true);
});

test('a quiet child request in an existing folder makes its removed conductor membership unknown', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.forms = [{ sessionID: 'ses_child' }];
  deps.realpath = async (path) => {
    if (path === WT) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.equal(inventory.unknown, true, 'a child form prevents silent absence of its removed conductor');
  assert.ok(w.calls.includes('/api/form?location%5Bdirectory%5D=%2Felsewhere'));
});

test('an active orphan in a removed folder is unknown rather than absent', async () => {
  const { w, deps } = machine();
  w.rows.push(row('ses_orphan', '/removed', 'ses_missing'));
  w.active = { ses_orphan: {} };
  deps.realpath = async (path) => {
    if (path === '/removed') throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.equal(inventory.unknown, true);
});

test('global snapshot reads the empty terminator beyond one hundred full history pages', async () => {
  const { w, deps } = machine();
  w.rows.splice(0, w.rows.length, row('ses_owner'));
  for (let i = 0; i < 9999; i++) w.rows.push({ ...row(`ses_history${i}`, ROOT, 'ses_owner'), outcome: 'succeeded' });
  w.active = {};
  w.forms = [{ sessionID: 'ses_history9998' }];
  const api = deps.api;
  let pages = 0;
  deps.api = async (method, path) => {
    const url = new URL(path, 'http://fake');
    if (url.pathname !== '/api/session') return api(method, path);
    const from = Number(url.searchParams.get('cursor') ?? 0);
    pages++;
    return { code: 0, stdout: JSON.stringify({ data: w.rows.slice(from, from + 100), cursor: { next: String(from + 100) } }) };
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.equal(pages, 101);
  assert.deepEqual(inventory.live, [{ id: 'ses_owner', dir: ROOT, busy: false, why: ['its subagent ses_history9998: a question form is open'], checkout: ROOT }]);
});


for (const repeated of ['cursor', 'session']) {
  test(`global snapshot refuses repeated ${repeated} progress without a fixed page budget`, async () => {
    const { deps } = machine();
    let pages = 0;
    deps.api = async () => {
      pages++;
      const id = repeated === 'session' ? 'ses_same' : `ses_page${pages}`;
      const next = repeated === 'cursor' ? 'same' : String(pages);
      return { code: 0, stdout: JSON.stringify({ data: [row(id)], cursor: { next } }) };
    };
    await assert.rejects(() => readSessionSnapshot(deps), /snapshot repeats|repeated cursor/);
    assert.equal(pages, 2);
  });
}


test('a completion notice arriving after the snapshot uses metadata read after the inbox', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows[1].time.updated = NOW - 7 * 60 * 60 * 1000;
  const api = deps.api;
  deps.api = async (method, path) => {
    if (path === '/api/session/ses_extra/inbox') {
      w.rows[1].time.updated = NOW;
      w.inbox.ses_extra = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', state: 'completed', childID: 'ses_child' } } }];
    }
    return api(method, path);
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, [{ id: 'ses_extra', dir: WT, busy: false, why: ['input is already queued'], checkout: WT }]);
  assert.equal(w.calls.filter((path) => path === '/api/session/ses_extra').length, 1);
  assert.ok(w.calls.indexOf('/api/session/ses_extra') > w.calls.indexOf('/api/session/ses_extra/inbox'));
});


test('all input source kinds share eight workers and no observations remain in flight at verdict time', async () => {
  const { w, deps } = machine();
  w.rows.splice(0, w.rows.length);
  w.active = {};
  for (let i = 0; i < 12; i++) {
    w.rows.push(row(`ses_mixed${i}`, `${ROOT}/dir${i}`));
    w.rows.at(-1).time.updated = 1;
    w.inbox[`ses_mixed${i}`] = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', state: 'completed', childID: 'ses_child' } } }];
  }
  const api = deps.api;
  let inflight = 0;
  let maximum = 0;
  deps.api = async (method, path) => {
    if (path.startsWith('/api/session?') || path === '/api/session/active') return api(method, path);
    inflight++;
    maximum = Math.max(maximum, inflight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await api(method, path);
    } finally { inflight--; }
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, []);
  assert.equal(inflight, 0);
  assert.equal(maximum, 8);
  assert.equal(w.calls.length, 2 + 1 + 12 + 12 + 24);
  assert.equal(new Set(w.calls).size, w.calls.length, 'every source is observed once');
});

test('removed history outside every project has no dependents and no inbox read', async () => {
  const { w, deps } = machine();
  w.rows.splice(0, w.rows.length, row('ses_unowned', '/removed'));
  w.active = {};
  deps.realpath = async (path) => {
    if (path === '/removed') throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, []);
  assert.ok(!w.calls.some((path) => path.endsWith('/inbox')));
});


function pagedApi(pages) {
  const calls = [];
  const api = async (method, path) => {
    calls.push(path);
    return path in pages ? { code: 0, stdout: JSON.stringify(pages[path]) } : { code: 1, stderr: `HTTP 400 Bad Request: ${path}` };
  };
  return { calls, api };
}

for (const last of [{ previous: 'p', next: null }, { previous: 'p' }]) {
  test(`a session listing ends on a page that holds sessions and gives ${'next' in last ? 'a null' : 'no'} next cursor, and no page is asked for after it`, async () => {
    const { deps } = machine();
    const snapshot = pagedApi({
      '/api/session?limit=1000': { data: [row('ses_a')], cursor: { previous: null, next: 'c1' } },
      '/api/session?limit=1000&cursor=c1': { data: [row('ses_b', WT, 'ses_a')], cursor: last },
    });
    const all = await readSessionSnapshot({ ...deps, api: snapshot.api });
    assert.deepEqual([...all.keys()], ['ses_a', 'ses_b']);
    assert.deepEqual(snapshot.calls, ['/api/session?limit=1000', '/api/session?limit=1000&cursor=c1']);
    const dir = `/api/session?directory=${encodeURIComponent(ROOT)}`;
    const folder = pagedApi({
      [dir]: { data: [row('ses_a')], cursor: { previous: null, next: 'c1' } },
      [`${dir}&cursor=c1`]: { data: [row('ses_c')], cursor: last },
    });
    assert.deepEqual((await topLevelSessionsAt(folder.api, ROOT)).map((s) => s.id), ['ses_a', 'ses_c']);
    assert.equal(folder.calls.length, 2);
  });
}

const checkoutInventory = (m) => readProjectInventory({ ...m.deps }, REGISTRY, 'proj', 'ses_owner');

test('the main conductor and the conductors of two session worktrees are all the project\'s, each in its own checkout', async () => {
  const m = checkoutMachine();
  m.w.active = { ses_owner: {}, ses_s2: {}, ses_s3: {} };
  const inventory = await checkoutInventory(m);
  assert.equal(inventory.unknown, undefined);
  assert.equal(inventory.main, ROOT);
  assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout]).sort(), [['ses_owner', ROOT], ['ses_s2', S2], ['ses_s3', S3]]);
  assert.equal(new Set(inventory.live.map((s) => s.checkout)).size, 3);
  assert.deepEqual(m.w.gitCalls, [ROOT], 'one git read for the project, not one per checkout');
});

test('a folder under <main folder>.worktrees that git does not register is not a checkout: a conductor there is nobody\'s', async () => {
  const m = checkoutMachine([row('ses_x', '/work/proj.worktrees/x')], { folders: ['session-2', 'session-3', 'x'] });
  m.w.active = { ses_x: {}, ses_s2: {} };
  m.w.inbox.ses_x = [{ type: 'user' }];
  const inventory = await checkoutInventory(m);
  assert.equal(inventory.unknown, undefined);
  assert.deepEqual(inventory.live.map((s) => s.id), ['ses_s2']);
});

test('request count: three checkouts cost one snapshot, one active list, one inbox per conductor and one form and permission read per folder', async () => {
  const m = checkoutMachine();
  m.w.active = { ses_s2: {} };
  m.w.calls.length = 0;
  await checkoutInventory(m);
  // No listing per checkout and no child listing per session: the snapshot is the only listing.
  assert.deepEqual(m.w.calls.filter((p) => p.startsWith('/api/session?')), ['/api/session?limit=1000', '/api/session?limit=1000&cursor=next']);
  assert.equal(m.w.calls.filter((p) => p.endsWith('/inbox')).length, 3, 'one inbox per conductor');
  assert.equal(m.w.calls.filter((p) => p.startsWith('/api/form?')).length, 3, 'one form read per folder');
  assert.equal(m.w.calls.filter((p) => p.startsWith('/api/permission/request?')).length, 3, 'one permission read per folder');
  assert.equal(m.w.calls.length, 12, m.w.calls.join('\n'));
  assert.deepEqual(m.w.gitCalls, [ROOT]);
});

test('a project with no session worktree folder pays no git read; an unreadable folder or a failed git read makes its inventory unknown', async () => {
  const none = checkoutMachine();
  none.deps.readdir = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  assert.equal((await checkoutInventory(none)).unknown, undefined);
  assert.deepEqual(none.w.gitCalls, []);
  const empty = checkoutMachine([], { folders: [] });
  assert.equal((await checkoutInventory(empty)).unknown, undefined);
  assert.deepEqual(empty.w.gitCalls, []);
  const denied = checkoutMachine();
  denied.deps.readdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal((await checkoutInventory(denied)).unknown, true);
  const failing = checkoutMachine();
  failing.deps.gitWorktrees = async () => { throw new Fail(1, 'git worktree list failed'); };
  assert.equal((await checkoutInventory(failing)).unknown, true);
  const noReader = checkoutMachine();
  delete noReader.deps.gitWorktrees;
  assert.equal((await checkoutInventory(noReader)).unknown, true);
});

const linked = (map) => async (p) => {
  for (const [from, to] of Object.entries(map)) if (p === from || p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return p;
};

test('a registered session worktree that resolves inside the main folder is not a checkout: its conductor counts as main checkout activity', async () => {
  const m = checkoutMachine([], { registered: [S2], folders: ['session-2'] });
  m.deps.realpath = linked({ [S2]: '/work/proj/nested' });
  m.w.active = { ses_s2: {} };
  const inventory = await checkoutInventory(m);
  assert.equal(inventory.unknown, undefined);
  assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout, s.unplaced === true]), [['ses_s2', ROOT, false]]);
});

test('a symlinked folder is a checkout when its resolved path is registered, whatever the names: the folder reader is asked for links and no basename must match', async () => {
  const m = checkoutMachine([row('ses_link', '/work/real/s2')], { registered: ['/work/real/s2'], folders: ['link-2'] });
  m.deps.realpath = linked({ '/work/proj.worktrees/link-2': '/work/real/s2' });
  const asked = [];
  const readdir = m.deps.readdir;
  m.deps.readdir = async (dir, options) => { asked.push([dir, options]); return readdir(dir, options); };
  m.w.active = { ses_link: {} };
  const inventory = await checkoutInventory(m);
  assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout]), [['ses_link', '/work/real/s2']]);
  assert.ok(asked.some(([dir, options]) => dir === '/work/proj.worktrees' && options?.links === true), 'the container is read with links');
});

test('a registered path that runs through a link is matched by its resolved folder', async () => {
  const m = checkoutMachine([], { registered: ['/work/via/proj.worktrees/session-2'], folders: ['session-2'] });
  m.deps.realpath = linked({ '/work/via': '/work' });
  m.w.active = { ses_s2: {} };
  const inventory = await checkoutInventory(m);
  assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout]), [['ses_s2', S2]]);
});

// Review round on the per-checkout step: the discovery has a budget, and a failed discovery stays with its project.
const TWO = [{ name: 'proj', repo_path: ROOT }, { name: 'other', repo_path: '/work/other' }];
const bothProjects = (m, extra = {}) => readProjectInventories({ ...m.deps, ...extra }, TWO, [{ project: 'proj', owner: 'ses_owner' }, { project: 'other', owner: 'ses_y' }]);
const finishesIn = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

test('a stalled read of one project\'s session worktree folder ends at the discovery bound: that project is unknown and the other projects are read', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other')]);
  m.w.active = { ses_y: {} };
  m.deps.readdir = (dir) => (dir === '/work/proj.worktrees' ? new Promise(() => {}) : Promise.resolve([]));
  const inventories = await finishesIn(bothProjects(m, { discoveryTimeoutMs: 20 }), 2_000, 'the inventory of both projects');
  assert.equal(inventories[0].unknown, true);
  assert.equal(inventories[1].unknown, undefined);
  assert.deepEqual(inventories[1].live.map((s) => s.id), ['ses_y']);
});

test('a stalled git read ends at the same bound: that project is unknown and the other projects are read', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other')]);
  m.w.active = { ses_y: {} };
  m.deps.gitWorktrees = () => new Promise(() => {});
  const inventories = await finishesIn(bothProjects(m, { discoveryTimeoutMs: 20 }), 2_000, 'the inventory of both projects');
  assert.equal(inventories[0].unknown, true);
  assert.equal(inventories[1].unknown, undefined);
  assert.deepEqual(inventories[1].live.map((s) => s.id), ['ses_y']);
});

test('a failed discovery of one project leaves only that project unknown, even when a session folder under it then cannot be resolved', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other')]);
  m.w.active = { ses_y: {}, ses_s2: {} };
  m.deps.realpath = async (p) => {
    if (p === S2 || p.startsWith(`${S2}/`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return p;
  };
  const inventories = await bothProjects(m);
  assert.equal(inventories[0].unknown, true);
  assert.equal(inventories[1].unknown, undefined, 'other has nothing to do with the folder that failed');
  assert.deepEqual(inventories[1].live.map((s) => s.id), ['ses_y']);
});

// Re-check of the discovery budget: a stalled read cannot be cancelled, so nothing that still waits on it may outlive its bound.
const afterMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a link resolution the discovery gave up on cannot stall the pass: the project is unknown, the other projects are read', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other')]);
  m.w.active = { ses_y: {} };
  // S2 is a folder in proj's session worktree folder (the discovery resolves it) and also a session's directory in the snapshot
  // (the later pass resolves it again through the same shared answer).
  m.deps.realpath = (p) => (p === S2 ? new Promise(() => {}) : Promise.resolve(p));
  const inventories = await finishesIn(bothProjects(m, { discoveryTimeoutMs: 20 }), 2_000, 'the inventory of both projects');
  assert.equal(inventories[0].unknown, true);
  assert.equal(inventories[1].unknown, undefined);
  assert.deepEqual(inventories[1].live.map((s) => s.id), ['ses_y']);
});

test('a session folder whose resolution stalls and belongs to no known project ends at the same bound: every project is unknown, none stalls', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other'), row('ses_far', '/elsewhere/box')]);
  m.w.active = { ses_y: {} };
  m.deps.realpath = (p) => (p === '/elsewhere/box' ? new Promise(() => {}) : Promise.resolve(p));
  const inventories = await finishesIn(bothProjects(m, { discoveryTimeoutMs: 20 }), 2_000, 'the inventory of both projects');
  assert.deepEqual(inventories.map((i) => i.unknown), [true, true]);
});

test('a discovery that gave up on a stalled read starts no folder read and no git read when that read finally returns', async () => {
  const m = checkoutMachine();
  const started = [];
  const realpath = m.deps.realpath;
  m.deps.realpath = (p) => { started.push(`realpath ${p}`); return realpath(p); };
  m.deps.readdir = async (dir) => {
    started.push(`readdir ${dir}`);
    await afterMs(60);
    return dir === '/work/proj.worktrees' ? ['session-2', 'session-3'] : [];
  };
  const inventory = await finishesIn(readProjectInventory({ ...m.deps, discoveryTimeoutMs: 20 }, REGISTRY, 'proj', 'ses_owner'), 2_000, 'the inventory');
  assert.equal(inventory.unknown, true);
  const before = [...started];
  await afterMs(150);
  assert.deepEqual(started, before, 'the abandoned discovery started no read after it gave up');
  assert.deepEqual(m.w.gitCalls, [], 'and no git read');
});

test('the git read gets what is left of the discovery, not the whole budget it started with', async () => {
  const m = checkoutMachine();
  let clock = NOW;
  const realpath = m.deps.realpath;
  const timeouts = [];
  m.deps.now = () => clock;
  // Every link resolution takes 100 ms of the clock: the folder holding the session worktrees and the two folders in it use 300 of the 500.
  m.deps.realpath = async (p) => { clock += 100; return realpath(p); };
  m.deps.gitWorktrees = async (root, ms) => { timeouts.push(ms); return [ROOT, S2, S3]; };
  const inventory = await readProjectInventory({ ...m.deps, discoveryTimeoutMs: 500 }, REGISTRY, 'proj', 'ses_owner');
  assert.equal(inventory.unknown, undefined);
  assert.deepEqual(timeouts, [200]);
});

test('no read starts once the discovery time is up, though every read before it returned: the project is unknown and git is never asked', async () => {
  const m = checkoutMachine();
  let clock = NOW;
  const realpath = m.deps.realpath;
  m.deps.now = () => clock;
  // The folder holding the session worktrees takes 300 ms, the first folder in it 300 more: the second folder has no time left.
  m.deps.realpath = async (p) => { clock += 300; return realpath(p); };
  const inventory = await readProjectInventory({ ...m.deps, discoveryTimeoutMs: 500 }, REGISTRY, 'proj', 'ses_owner');
  assert.equal(inventory.unknown, true);
  assert.deepEqual(m.w.gitCalls, []);
});

// PR #122 Copilot round 1, comment 4371975495: the discovery names the folders it reads as evidence before it resolves them, so a
// failed read stays with its project. A session stored under the resolved path of a linked session worktree folder has no
// lexical tie to the link, so the children of the resolved folder are named too, before any of them is resolved.
test('a recorded owner in the main checkout stays the owner in the inventory, in the folder itself or below it', async () => {
  for (const dir of [ROOT, `${ROOT}/sub`]) {
    const m = checkoutMachine([row('ses_main', dir)]);
    m.w.active = { ses_main: {} };
    const inventory = await readProjectInventory({ ...m.deps }, REGISTRY, 'proj', 'ses_main');
    assert.equal(inventory.owner, 'ses_main', dir);
  }
});

// PR #122 Copilot round 2: two links in the session worktree folder may lead to nested registered worktrees. Each conductor
// stays in the checkout that holds it, whichever link the folder read lists first.
test('conductors of nested session worktrees each stay in their own checkout, whichever link is listed first', async () => {
  const OUTER = '/work/outer';
  const INNER = '/work/outer/inner';
  for (const folders of [['a', 'b'], ['b', 'a']]) {
    const m = checkoutMachine([row('ses_outer', OUTER), row('ses_inner', INNER)], { registered: [OUTER, INNER], folders });
    m.deps.realpath = linked({ '/work/proj.worktrees/a': OUTER, '/work/proj.worktrees/b': INNER });
    m.w.active = { ses_outer: {}, ses_inner: {} };
    const inventory = await checkoutInventory(m);
    assert.equal(inventory.unknown, undefined, folders.join(' then '));
    assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout]).sort(), [['ses_inner', INNER], ['ses_outer', OUTER]], folders.join(' then '));
  }
});

const RESET_SET_AT = '2026-10-26T09:00:00.000Z';
const RESET_AT = Date.parse(RESET_SET_AT);
const rowAt = (id, dir, created, extra = {}) => ({ ...row(id, dir), time: { created, updated: created }, ...extra });
const readWith = (m, project) => readProjectInventories({ ...m.deps }, REGISTRY, [project]);

test('likelyReset over the inventory finds the checkout whose owner was cleared and leaves the other checkouts alone', async () => {
  const m = checkoutMachine([rowAt('ses_new', ROOT, RESET_AT + 5_000)]);
  m.w.rows[0].time = { created: RESET_AT - 60_000, updated: NOW };
  const inventory = await checkoutInventory(m);
  const inCheckout = (checkout) => inventory.tops.filter((t) => t.checkout === checkout);
  assert.deepEqual(likelyReset({ session: 'ses_owner', set_at: RESET_SET_AT }, inCheckout(ROOT)).map((t) => t.id), ['ses_new']);
  assert.deepEqual(likelyReset({ session: 'ses_s2', set_at: RESET_SET_AT }, inCheckout(S2)), []);
});

test('request count: exposing the conductors and keeping the checkout owners costs no call beyond the snapshot, the active list and the existing reads', async () => {
  const calls = async (project) => {
    const m = checkoutMachine([rowAt('ses_new', ROOT, RESET_AT + 5_000)]);
    m.w.calls.length = 0;
    await readWith(m, project);
    return m.w.calls;
  };
  const plain = await calls({ project: 'proj', owner: 'ses_owner' });
  const owned = await calls({ project: 'proj', owner: 'ses_owner', checkoutOwners: { [S2]: 'ses_s2', [S3]: 'ses_gone' } });
  assert.deepEqual([...owned].sort(), [...plain].sort(), 'the same calls with and without the checkout owners');
  assert.deepEqual(plain.filter((p) => p.startsWith('/api/session?')), ['/api/session?limit=1000', '/api/session?limit=1000&cursor=next'], 'the snapshot is the only listing');
  assert.deepEqual(plain.filter((p) => /^\/api\/session\/ses_\w+$/.test(p)), [], 'no session is read by id');
});

test('the recorded owner of a session checkout is kept while it runs there, dropped when it is a conductor of another checkout, and kept when it is gone', async () => {
  const [inventory] = await readWith(checkoutMachine(), { project: 'proj', owner: 'ses_owner', checkoutOwners: { [S2]: 'ses_s2', [S3]: 'ses_owner' } });
  assert.deepEqual(inventory.checkoutOwners, { [S2]: 'ses_s2' });
  const [gone] = await readWith(checkoutMachine(), { project: 'proj', owner: 'ses_owner', checkoutOwners: { [S3]: 'ses_gone' } });
  assert.deepEqual(gone.checkoutOwners, { [S3]: 'ses_gone' });
});

// The whole-history snapshot (board aedcf153). On 2026-10-26 the server held about 5,500 sessions and a snapshot was 56
// requests of 100 rows, each one `opencode api` process; the server takes any limit (limit=10000 answered all of them), and
// the V2 spec makes limit a maximum, so a page may hold fewer rows and the listing is followed to its empty last page.
function historyApi(count, serverMax) {
  const rows = Array.from({ length: count }, (_, i) => row(`ses_h${i}`, '/elsewhere'));
  const calls = [];
  const api = async (method, path) => {
    calls.push(path);
    const url = new URL(path, 'http://fake');
    const size = Math.min(Number(url.searchParams.get('limit') ?? 50), serverMax);
    const from = Number(url.searchParams.get('cursor')?.slice(1) ?? 0);
    return { code: 0, stdout: JSON.stringify({ data: rows.slice(from, from + size), cursor: { previous: null, next: `c${from + size}` } }) };
  };
  return { calls, api };
}

test('the session snapshot asks for pages of 1000: 2,500 sessions are three pages and the empty one', async () => {
  const h = historyApi(2_500, 10_000);
  const all = await readSessionSnapshot({ api: h.api });
  assert.equal(all.size, 2_500);
  assert.deepEqual(h.calls, ['/api/session?limit=1000', '/api/session?limit=1000&cursor=c1000', '/api/session?limit=1000&cursor=c2000', '/api/session?limit=1000&cursor=c3000']);
});

test('a server that caps a page below the limit still gives the complete snapshot, one request per page and the empty one', async () => {
  const h = historyApi(2_500, 100);
  assert.equal((await readSessionSnapshot({ api: h.api })).size, 2_500);
  assert.equal(h.calls.length, 26);
});

test('readProjectInventories takes an observed snapshot and running list, reads neither, and gives the verdict of one that reads both', async () => {
  const { w, deps } = machine();
  const registry = [{ name: 'proj', repo_path: ROOT }];
  const projects = [{ project: 'proj', owner: 'ses_owner' }];
  const snapshot = await readSessionSnapshot(deps);
  w.calls.length = 0;
  const observed = await readProjectInventories({ ...deps }, registry, projects, { snapshot, active: ['ses_child'] });
  assert.deepEqual(w.calls.filter((p) => p.startsWith('/api/session?') || p === '/api/session/active'), [], 'no listing and no running-list read of its own');
  assert.ok(w.calls.length > 0, 'the input reads still happen');
  assert.deepEqual(observed, await readProjectInventories({ ...deps }, registry, projects));
  assert.equal(observed[0].live.some((s) => s.why.includes('its subagent ses_child is busy')), true);
});

test('an observed running session the observed snapshot lacks leaves the project unknown, as one the inventory read itself does', async () => {
  const { deps } = machine();
  const registry = [{ name: 'proj', repo_path: ROOT }];
  const snapshot = await readSessionSnapshot(deps);
  const [verdict] = await readProjectInventories({ ...deps }, registry, [{ project: 'proj', owner: 'ses_owner' }], { snapshot, active: ['ses_unlisted'] });
  assert.equal(verdict.unknown, true);
});

// ---- Restored from CH.Hub: behaviour the port kept, driven through readProjectInventories directly. ----

const readAll = (deps, registry, owners = {}, extra = {}) => readProjectInventories({ ...deps, ...extra }, registry, registry.map((r) => ({ project: r.name, owner: owners[r.name] })));
const TWO_ROWS = [{ name: 'proj', repo_path: ROOT }, { name: 'other', repo_path: '/work/other' }];

test('parseGitWorktrees reads the paths of `git worktree list --porcelain -z`, unquoted', () => {
  const out = ['worktree /p/proj', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /p/proj.worktrees/session 2', 'HEAD def', 'detached', '', ''].join('\0');
  assert.deepEqual(parseGitWorktrees(out), ['/p/proj', '/p/proj.worktrees/session 2']);
  assert.deepEqual(parseGitWorktrees(''), []);
});

test('resolveProject: a registered name gives its root without a trailing slash; none is exit 2, two roots is exit 1', () => {
  assert.equal(resolveProject([{ name: 'a', repo_path: '/w/a/' }, { name: 'a', repo_path: '/w/a' }], 'a'), '/w/a');
  assert.throws(() => resolveProject([], 'a'), (e) => e instanceof Fail && e.code === 2 && /not in the Sterling project registry/.test(e.message));
  assert.throws(() => resolveProject([{ name: 'a', repo_path: '/w/a' }, { name: 'a', repo_path: '/v/a' }], 'a'), (e) => e instanceof Fail && e.code === 1 && /ambiguous/.test(e.message));
  assert.throws(() => resolveProject('1 registered Sterling project:', 'a'), (e) => e instanceof Fail && e.code === 1);
});

test('a session page that holds sessions is still refused with no cursor, a cursor that is not an object, or a next cursor that is a number or empty', async () => {
  const { deps } = machine();
  for (const cursor of [undefined, null, 'next', ['c1'], { next: 7 }, { next: '' }, { next: {} }]) {
    const page = cursor === undefined ? { data: [row('ses_a')] } : { data: [row('ses_a')], cursor };
    const snapshot = pagedApi({ '/api/session?limit=1000': page });
    await assert.rejects(() => readSessionSnapshot({ ...deps, api: snapshot.api }), /no usable cursor/, JSON.stringify(cursor));
    const folder = pagedApi({ [`/api/session?directory=${encodeURIComponent(ROOT)}`]: page });
    await assert.rejects(() => topLevelSessionsAt(folder.api, ROOT), /no usable cursor/, JSON.stringify(cursor));
  }
});

test('the inventory reads the active list and the snapshot once, and traces a child request in another folder', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.forms = [{ sessionID: 'ses_child' }];
  const [inventory] = await readAll(deps, TWO_ROWS, { proj: 'ses_owner' });
  assert.equal(inventory.project, 'proj');
  assert.equal(inventory.owner, 'ses_owner');
  assert.equal(inventory.live.find((s) => s.id === 'ses_extra').why.includes('its subagent ses_child: a question form is open'), true);
  assert.equal(w.calls.filter((p) => p.startsWith('/api/session/active')).length, 1);
  assert.equal(w.calls.filter((p) => p === '/api/session?limit=1000').length, 1);
  assert.ok(w.calls.some((p) => p.includes('directory%5D=%2Felsewhere')));
});

test('a nested quiet child permission in a different folder is traced to its conductor', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows.push(row('ses_nested', '/nested', 'ses_child'));
  w.perms = [{ sessionID: 'ses_nested' }];
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.deepEqual(inventory.live, [{ id: 'ses_extra', dir: WT, busy: false, why: ['its subagent ses_nested: a permission request is open'], checkout: WT }]);
  assert.ok(w.calls.includes('/api/permission/request?location%5Bdirectory%5D=%2Fnested'));
});

test('two projects share one global session snapshot and partition explicit conductors correctly', async () => {
  const { w, deps } = machine();
  w.rows[0].agent = 'sterling/conductor';
  w.rows.push({ ...row('ses_y', '/work/other'), agent: 'sterling/conductor' });
  w.active = { ses_owner: {}, ses_y: {} };
  const inventories = await readAll(deps, TWO_ROWS);
  assert.deepEqual(inventories.map((i) => [i.project, i.live.map((s) => s.id)]), [['proj', ['ses_owner']], ['other', ['ses_y']]]);
  assert.equal(w.calls.filter((p) => p === '/api/session?limit=1000').length, 1);
});

test('a removed-folder historical child does not make the inventory unknown or query its location', async () => {
  const { w, deps } = machine();
  w.active = {};
  const gone = '/work/proj.worktrees/removed';
  w.rows.push({ ...row('ses_completed', gone, 'ses_extra'), outcome: 'succeeded' });
  deps.realpath = async (path) => {
    if (path === gone) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const api = deps.api;
  deps.api = async (method, path) => {
    if (!path.includes(encodeURIComponent(gone))) return api(method, path);
    w.calls.push(path);
    return { code: 1, stderr: 'HTTP 404 Not Found', stdout: '{"_tag":"LocationNotFoundError"}' };
  };
  const inventory = await readProjectInventory({ ...deps }, REGISTRY, 'proj');
  assert.equal(inventory.unknown, undefined, 'a removed historical child leaves a healthy inventory');
  assert.ok(!w.calls.some((path) => path.includes(encodeURIComponent(gone))));
});

test('snapshot pages plus location reads plus candidate inboxes bound a nine-project pass independently of child history', async () => {
  const { w, deps } = machine();
  w.rows.length = 0;
  w.active = {};
  const names = Array.from({ length: 9 }, (_, i) => `p${i}`);
  const registry = names.map((name) => ({ name, repo_path: `/work/${name}` }));
  for (const [i, name] of names.entries()) {
    for (let j = 0; j < 50; j++) {
      const id = `ses_p${i}c${j}`;
      w.rows.push(row(id, `/work/${name}`));
      if (j === 0) {
        w.rows.at(-1).time.updated = NOW - STALE_SUBAGENT_NOTICE_MS;
        w.inbox[id] = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', state: 'completed', childID: `${id}child0` } } }];
      }
      for (let k = 0; k < 10; k++) w.rows.push({ ...row(`${id}child${k}`, `/work/${name}`, id), outcome: 'succeeded' });
    }
    w.rows.push({ ...row(`ses_archived${i}`, `/work/${name}`), time: { created: 1, updated: NOW, archived: NOW } });
    w.rows.push({ ...row(`ses_worker${i}`, `/work/${name}`), agent: 'sterling-maintenance-worker' });
  }
  const api = deps.api;
  let inboxes = 0;
  let maxInboxes = 0;
  let pages = 0;
  deps.api = async (method, path) => {
    const url = new URL(path, 'http://fake');
    if (url.pathname === '/api/session' && !url.searchParams.has('directory') && !url.searchParams.has('parentID')) {
      w.calls.push(path);
      const from = Number(url.searchParams.get('cursor') ?? 0);
      pages++;
      return { code: 0, stdout: JSON.stringify({ data: w.rows.slice(from, from + 100), cursor: { next: String(from + 100) } }) };
    }
    if (path.endsWith('/inbox')) {
      inboxes++;
      maxInboxes = Math.max(maxInboxes, inboxes);
      await new Promise((resolve) => setImmediate(resolve));
      try { return await api(method, path); } finally { inboxes--; }
    }
    return api(method, path);
  };
  const inventories = await readAll(deps, registry);
  assert.equal(inventories.length, 9);
  assert.ok(inventories.every((inventory) => inventory.live.length === 0));
  assert.equal(w.calls.filter((p) => new URL(p, 'http://fake').searchParams.has('parentID')).length, 0, 'no per-parent descendant listings');
  assert.equal(pages, Math.ceil(w.rows.length / 100) + 1);
  assert.equal(w.calls.filter((p) => p.endsWith('/inbox')).length, 450);
  assert.equal(w.calls.filter((p) => p === '/api/session/active').length, 1);
  assert.ok(maxInboxes <= 8 && maxInboxes > 1, `inbox concurrency ${maxInboxes}`);
  // Only the nine completed-notice candidates need current metadata after their inbox.
  const metadataReads = w.calls.filter((path) => /^\/api\/session\/ses_[A-Za-z0-9]+$/.test(path));
  assert.deepEqual(new Set(metadataReads), new Set(names.map((_, i) => `/api/session/ses_p${i}c0`)));
  assert.equal(metadataReads.length, names.length);
  for (const path of metadataReads) assert.ok(w.calls.indexOf(path) > w.calls.indexOf(`${path}/inbox`));
  assert.equal(w.calls.length, pages + 1 + 2 * names.length + 450 + names.length);
});

test('a failed inbox read keeps the shared workers bounded and other projects healthy', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows.length = 0;
  for (let i = 0; i < 24; i++) w.rows.push(row(`ses_inbox${i}`, i < 12 ? ROOT : '/work/other'));
  const api = deps.api;
  let running = 0;
  let maximum = 0;
  deps.api = async (method, path) => {
    if (!path.endsWith('/inbox')) return api(method, path);
    running++;
    maximum = Math.max(maximum, running);
    try {
      if (path === '/api/session/ses_inbox0/inbox') return { code: 1, stderr: 'HTTP 503 Unavailable' };
      await new Promise((resolve) => setImmediate(resolve));
      return await api(method, path);
    } finally { running--; }
  };
  const inventories = await readAll(deps, TWO_ROWS);
  assert.equal(inventories[0].unknown, true);
  assert.deepEqual(inventories[1].live, []);
  assert.ok(maximum <= 8, `inbox concurrency ${maximum}`);
  assert.equal(running, 0);
});

test('removed top-level history reads one inbox and only its attributed project stays unknown', async () => {
  const { w, deps } = machine();
  w.active = {};
  const removed = '/work/proj.worktrees/removed';
  w.rows.push(row('ses_removed', removed));
  w.inbox.ses_removed = [{ type: 'user' }];
  deps.realpath = async (path) => {
    if (path === removed) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const inventories = await readAll(deps, TWO_ROWS);
  assert.equal(inventories[0].unknown, true);
  assert.deepEqual(inventories[1].live, []);
  assert.ok(!inventories[1].unknown);
  assert.equal(w.calls.filter((path) => path === '/api/session/ses_removed/inbox').length, 1);
});

test('an unreadable project root degrades only its inventory; a different project is read', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows.push(row('ses_y', '/work/other'));
  deps.realpath = async (path) => {
    if (path === ROOT) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return path;
  };
  const inventories = await readAll(deps, TWO_ROWS);
  assert.equal(inventories[0].unknown, true);
  assert.deepEqual(inventories[1].live, []);
  assert.ok(!inventories[1].unknown);
});

test('input that arrives after the inbox read is captured empty for every project and appears on the next pass', async () => {
  const { w, deps } = machine();
  w.active = {};
  w.rows.splice(0, w.rows.length, row('ses_extra'));
  deps.realpath = async (path) => (path === '/work/other' ? ROOT : path);
  const api = deps.api;
  let arrived = false;
  deps.api = async (method, path) => {
    const result = await api(method, path);
    if (!arrived && path === '/api/session/ses_extra/inbox') {
      arrived = true;
      w.inbox.ses_extra = [{ type: 'user' }]; // The reply is already captured empty.
    }
    return result;
  };
  const owners = { proj: 'ses_owner', other: 'ses_owner' };
  const first = await readAll(deps, TWO_ROWS, owners);
  assert.ok(arrived);
  assert.ok(first.every((inventory) => !inventory.unknown && inventory.live.length === 0));
  const second = await readAll(deps, TWO_ROWS, owners);
  assert.deepEqual(second.map((inventory) => inventory.live.map((session) => session.id)), [['ses_extra'], ['ses_extra']]);
  assert.equal(w.calls.filter((call) => call === '/api/session/ses_extra/inbox').length, 2);
});

test('a shared directory resolution failure preserves every dependent occurrence without degrading unrelated projects', async () => {
  const { w, deps } = machine();
  const dir = `${ROOT}/nested`;
  w.rows.splice(0, w.rows.length, row('ses_extra', dir));
  w.active = {};
  w.inbox.ses_extra = [{ type: 'user' }];
  let denied = false;
  deps.realpath = async (path) => {
    if (path === '/work/other') return ROOT;
    if (path === dir && denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return path;
  };
  const registry = [...TWO_ROWS, { name: 'third', repo_path: '/work/third' }];
  const owners = { proj: 'ses_owner', other: 'ses_owner' };
  const prior = { proj: { ses_extra: {} }, other: { ses_extra: {} } };
  const healthy = await readAll(deps, registry, owners, { priorSessions: prior });
  assert.deepEqual(healthy.map((inventory) => !!inventory.unknown), [false, false, false]);
  assert.deepEqual(healthy.map((inventory) => inventory.live.map((s) => s.id)), [['ses_extra'], ['ses_extra'], []]);
  denied = true;
  for (let i = 0; i < 2; i++) {
    const inventories = await readAll(deps, registry, owners, { priorSessions: prior });
    assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, true, false]);
    assert.deepEqual(inventories[2].live, []);
  }
});

test('an active session in a vanished folder with no prior membership makes every project unknown', async () => {
  const { w, deps } = machine();
  w.rows.splice(0, w.rows.length, row('ses_extra', '/old-alias/proj'));
  w.active = { ses_extra: {} };
  deps.realpath = async (path) => {
    if (path === '/old-alias/proj') throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return path;
  };
  const inventories = await readAll(deps, TWO_ROWS);
  assert.ok(inventories.every((inventory) => inventory.unknown));
});

test('a registered session worktree whose folder is gone (prunable) is skipped; a folder that links to a registered one counts under its resolved path', async () => {
  const m = checkoutMachine([], { registered: ['/work/proj.worktrees/session-gone', '/work/real/proj.worktrees/session-2'], folders: ['session-2', 'session-gone'] });
  m.deps.realpath = async (p) => {
    if (p === '/work/proj.worktrees/session-gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return p.startsWith(S2) ? p.replace('/work/proj.worktrees', '/work/real/proj.worktrees') : p;
  };
  m.w.active = { ses_s2: {} };
  const inventory = await checkoutInventory(m);
  assert.equal(inventory.unknown, undefined);
  assert.deepEqual(inventory.live.map((s) => [s.id, s.checkout]), [['ses_s2', '/work/real/proj.worktrees/session-2']]);
});

test('a registered folder that resolves around the main folder is never a checkout, whatever git registers', async () => {
  const m = checkoutMachine([row('ses_y', '/work/other')], { registered: ['/work'], folders: ['session-2'] });
  m.deps.realpath = linked({ [S2]: '/work' });
  m.w.active = { ses_y: {} };
  const inventory = await checkoutInventory(m);
  assert.equal(inventory.unknown, undefined);
  assert.deepEqual(inventory.live.map((s) => s.id), []);
});

test('the discovery reads get the time left of the run, and none starts once the deadline has passed; without a deadline the bound is still finite', async () => {
  const m = checkoutMachine();
  const timeouts = [];
  let listings = 0;
  const readdir = m.deps.readdir;
  m.deps.readdir = async (...args) => { listings++; return readdir(...args); };
  m.deps.gitWorktrees = async (root, ms) => { timeouts.push(ms); return [ROOT, S2, S3]; };
  const inventory = (extra) => readProjectInventory({ ...m.deps, ...extra }, REGISTRY, 'proj', 'ses_owner');
  assert.equal((await inventory({ deadline: NOW + 3_000 })).unknown, undefined);
  assert.deepEqual(timeouts, [3_000], 'the git read gets what is left of the run');
  timeouts.length = 0;
  listings = 0;
  assert.equal((await inventory({ deadline: NOW })).unknown, true);
  assert.deepEqual(timeouts, [], 'no git read starts after the deadline');
  assert.equal(listings, 0, 'no folder read starts after the deadline either');
  assert.equal((await inventory({})).unknown, undefined);
  assert.equal(timeouts.length, 1);
  assert.ok(Number.isFinite(timeouts[0]) && timeouts[0] > 0, 'with no deadline the git read still has a finite bound');
});

test('a session folder under the resolved path of a linked session worktree folder stays attributed to that project when a child cannot be resolved', async () => {
  const BOX = '/work/box';
  const m = checkoutMachine([row('ses_y', '/work/other'), row('ses_box', `${BOX}/session-2`)], { registered: [`${BOX}/session-2`], folders: ['session-2'] });
  m.deps.realpath = async (p) => {
    if (p === '/work/proj.worktrees') return BOX;
    if (p === S2 || p === `${BOX}/session-2`) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return p;
  };
  m.w.active = { ses_y: {}, ses_box: {} };
  const inventories = await bothProjects(m);
  assert.equal(inventories[0].unknown, true);
  assert.equal(inventories[1].unknown, undefined, 'other has nothing to do with the folder that failed');
  assert.deepEqual(inventories[1].live.map((s) => s.id), ['ses_y']);
});

test('a recorded owner that runs in a session worktree is no owner in the inventory, and the sole live main conductor stays the only one', async () => {
  const m = checkoutMachine();
  m.w.active = { ses_owner: {} };
  const inventory = await readProjectInventory({ ...m.deps }, REGISTRY, 'proj', 'ses_s2');
  assert.equal(inventory.unknown, undefined);
  assert.equal(inventory.owner, undefined);
  assert.deepEqual(inventory.live.map((s) => s.id), ['ses_owner']);
});

test('the inventory lists the top-level conductors of every checkout with their creation order; a subagent, an archived session, another agent and a conductor in an unregistered folder are left out', async () => {
  const m = checkoutMachine([
    rowAt('ses_new', ROOT, RESET_AT + 5_000), row('ses_kid', ROOT, 'ses_owner'),
    rowAt('ses_arch', ROOT, 9, { time: { created: 9, updated: NOW, archived: 10 } }), rowAt('ses_worker', ROOT, 9, { agent: 'sterling-maintenance-worker' }), row('ses_unregistered', WT),
  ]);
  const inventory = await checkoutInventory(m);
  assert.deepEqual(inventory.tops.map((t) => [t.id, t.checkout, t.created]).sort(), [['ses_new', ROOT, RESET_AT + 5_000], ['ses_owner', ROOT, 1], ['ses_s2', S2, 1], ['ses_s3', S3, 1]]);
  assert.deepEqual(inventory.tops.find((t) => t.id === 'ses_new'), { id: 'ses_new', created: RESET_AT + 5_000, updated: RESET_AT + 5_000, checkout: ROOT });
});

// ---- Restored from CH.Hub, round 2: shared observations, prior membership and request dependencies. ----
// The watcher kept the previous pass's sessions between ticks; here the caller passes them as deps.priorSessions
// ({ project: { sessionId: { requestPending } } }), which is the only thing the inventory reads of that state.

const THREE_ROWS = [...TWO_ROWS, { name: 'third', repo_path: '/work/third' }];
const priorFor = (projects, sessions, extra = {}) => Object.fromEntries(projects.map((p) => [p, Object.fromEntries(sessions.map((s) => [s, { ...extra }]))]));
const inboxCalls = (w, id) => w.calls.filter((path) => (id ? path === `/api/session/${id}/inbox` : path.endsWith('/inbox'))).length;

for (const kind of ['form', 'permission']) {
  test(`one shared ${kind} observation gives every project the same verdict and sees post-pass requests on the next pass`, async () => {
    const { w, deps } = machine();
    w.rows.splice(0, w.rows.length, row('ses_extra'));
    w.active = {};
    let plannedOther = false;
    deps.realpath = async (path) => {
      if (path === '/work/other') { plannedOther = true; return ROOT; }
      return path;
    };
    const api = deps.api;
    const observed = new Set();
    let opened = false;
    deps.api = async (method, path) => {
      const result = await api(method, path);
      if (path.startsWith('/api/form?') || path.startsWith('/api/permission/request?') || path.endsWith('/inbox')) {
        assert.ok(plannedOther, 'every project is planned before the shared observation pass');
        observed.add(path.split('?')[0]);
        if (!opened && observed.size === 3) {
          opened = true; // All three replies were captured empty; the new request is after that observation set.
          w[kind === 'form' ? 'forms' : 'perms'] = [{ sessionID: 'ses_extra' }];
        }
      }
      return result;
    };
    const owners = { proj: 'ses_owner', other: 'ses_owner' };
    const first = await readAll(deps, TWO_ROWS, owners);
    assert.ok(opened);
    assert.ok(first.every((inventory) => !inventory.unknown && inventory.live.length === 0));
    const second = await readAll(deps, TWO_ROWS, owners);
    assert.deepEqual(second.map((inventory) => inventory.live.map((session) => session.id)), [['ses_extra'], ['ses_extra']]);
    assert.equal(w.calls.filter((path) => path.startsWith('/api/form?')).length, 2);
    assert.equal(w.calls.filter((path) => path.startsWith('/api/permission/request?')).length, 2);
    assert.equal(inboxCalls(w), 2);
  });
}

for (const fault of ['inbox', 'form', 'permission', 'metadata']) {
  test(`one failed shared ${fault} source only degrades its dependent projects`, async () => {
    const { w, deps } = machine();
    w.rows.splice(0, w.rows.length, row('ses_shared'), row('ses_z', '/work/third'));
    w.active = {};
    deps.realpath = async (path) => (path === '/work/other' ? ROOT : path);
    if (fault === 'metadata') {
      w.rows[0].time.updated = 1;
      w.inbox.ses_shared = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', state: 'completed', childID: 'ses_child' } } }];
    }
    const form = `/api/form?location%5Bdirectory%5D=${encodeURIComponent(ROOT)}`;
    const permission = `/api/permission/request?location%5Bdirectory%5D=${encodeURIComponent(ROOT)}`;
    const target = { inbox: '/api/session/ses_shared/inbox', metadata: '/api/session/ses_shared', form, permission }[fault];
    const api = deps.api;
    deps.api = async (method, path) => {
      if (path !== target) return api(method, path);
      w.calls.push(path);
      return { code: 1, stderr: 'HTTP 503 Unavailable' };
    };
    const inventories = await readAll(deps, THREE_ROWS);
    assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, true, false]);
    assert.deepEqual(inventories[2].live, []);
    assert.equal(w.calls.filter((path) => path === target).length, 1);
    assert.equal(w.calls.filter((path) => path === form).length, 1);
    assert.equal(w.calls.filter((path) => path === permission).length, 1);
  });
}

for (const activity of ['conductor', 'child']) {
  test(`an active vanished alias preserves prior projects for a running ${activity}`, async () => {
    const { w, deps } = machine();
    const alias = '/old-alias/proj';
    w.rows.splice(0, w.rows.length, row('ses_extra', alias));
    if (activity === 'child') w.rows.push(row('ses_aliaschild', '/elsewhere', 'ses_extra'));
    w.active = { [activity === 'child' ? 'ses_aliaschild' : 'ses_extra']: {} };
    let gone = false;
    deps.realpath = async (path) => {
      if (path === '/work/other') return ROOT;
      if (path === alias) {
        if (gone) throw Object.assign(new Error('removed alias'), { code: 'ENOENT' });
        return ROOT;
      }
      return path;
    };
    const owners = { proj: 'ses_owner', other: 'ses_owner' };
    const healthy = await readAll(deps, THREE_ROWS, owners);
    assert.deepEqual(healthy.map((inventory) => !!inventory.unknown), [false, false, false]);
    assert.deepEqual(healthy.map((inventory) => inventory.live.map((s) => s.id)), [['ses_extra'], ['ses_extra'], []]);
    const priorSessions = priorFor(['proj', 'other'], ['ses_extra']);
    gone = true;
    for (let pass = 0; pass < 2; pass++) {
      const inventories = await readAll(deps, THREE_ROWS, owners, { priorSessions });
      assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, true, false]);
    }
    w.active = {};
    const before = inboxCalls(w);
    const idle = await readAll(deps, THREE_ROWS, owners, { priorSessions });
    assert.ok(idle.every((inventory) => !inventory.unknown && inventory.live.length === 0), 'idle removed alias history remains ignored');
    assert.equal(inboxCalls(w), before + 1, 'prior membership needs one empty inbox read before removed history can be ignored');
  });
}

for (const input of ['pending', 'unreadable']) {
  test(`a quiet vanished alias with ${input} input stays unknown until one empty inbox read`, async () => {
    const { w, deps } = machine();
    const alias = '/old-alias/proj';
    w.rows.splice(0, w.rows.length, row('ses_extra', alias));
    w.active = {};
    w.inbox.ses_extra = [{ type: 'user' }];
    let gone = false;
    let rejectInbox = input === 'unreadable';
    deps.realpath = async (path) => {
      if (path === '/work/other') return ROOT;
      if (path === alias) {
        if (gone) throw Object.assign(new Error('removed alias'), { code: 'ENOENT' });
        return ROOT;
      }
      return path;
    };
    const api = deps.api;
    deps.api = async (method, path) => {
      if (gone && rejectInbox && path === '/api/session/ses_extra/inbox') {
        w.calls.push(path);
        return { code: 1, stderr: 'HTTP 503 Unavailable' };
      }
      return api(method, path);
    };
    const owners = { proj: 'ses_owner', other: 'ses_owner' };
    const healthy = await readAll(deps, THREE_ROWS, owners);
    assert.deepEqual(healthy.map((inventory) => inventory.live.map((s) => s.why)), [[['input is already queued']], [['input is already queued']], []]);
    const priorSessions = priorFor(['proj', 'other'], ['ses_extra']);
    gone = true;
    for (let pass = 0; pass < 2; pass++) {
      const before = inboxCalls(w);
      const inventories = await readAll(deps, THREE_ROWS, owners, { priorSessions });
      assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, true, false]);
      assert.equal(inboxCalls(w), before + 1);
    }
    rejectInbox = false;
    w.inbox.ses_extra = [];
    const before = inboxCalls(w);
    const idle = await readAll(deps, THREE_ROWS, owners, { priorSessions });
    assert.ok(idle.every((inventory) => !inventory.unknown && inventory.live.length === 0));
    assert.equal(inboxCalls(w), before + 1, 'one empty read proves the removed prior session is quiet');
  });
}

for (const kind of ['form', 'permission']) {
  test(`an unfinished quiet child with a missing ${kind} location keeps its parent's project unknown until the child ends`, async () => {
    const { w, deps } = machine();
    const dir = '/work/proj.worktrees/waiting-child';
    w.rows[1].outcome = 'succeeded'; // The parent's old outcome does not complete its child.
    w.rows[2].location.directory = dir;
    w.active = {};
    w[kind === 'form' ? 'forms' : 'perms'] = [{ sessionID: 'ses_child' }];
    let gone = false;
    deps.realpath = async (path) => {
      if (path === dir && gone) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
      return path;
    };
    const owners = { proj: 'ses_owner' };
    const healthy = await readAll(deps, TWO_ROWS, owners);
    assert.deepEqual(healthy.map((inventory) => !!inventory.unknown), [false, false]);
    assert.ok(healthy[0].live[0].why.some((why) => why.startsWith('its subagent ses_child: ')));
    const priorSessions = priorFor(['proj'], ['ses_extra'], { requestPending: true });
    gone = true;
    for (let pass = 0; pass < 2; pass++) {
      const inventories = await readAll(deps, TWO_ROWS, owners, { priorSessions });
      assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, false]);
    }
    w.rows[2].outcome = 'succeeded';
    const ended = await readAll(deps, TWO_ROWS, owners, { priorSessions });
    assert.ok(ended.every((inventory) => !inventory.unknown && inventory.live.length === 0), "the child's own terminal outcome establishes removed history");
  });
}

for (const kind of ['form', 'permission']) {
  for (const startQueued of [false, true]) {
    test(`a quiet top-level ${kind} survives a missing folder after ${startQueued ? 'queued input turns into a request' : 'direct observation'}`, async () => {
      const { w, deps } = machine();
      w.active = {};
      w.rows[1].outcome = 'succeeded'; // A conductor's prior turn outcome does not close its request.
      const requests = kind === 'form' ? 'forms' : 'perms';
      if (startQueued) w.inbox.ses_extra = [{ type: 'user' }];
      else w[requests] = [{ sessionID: 'ses_extra' }];
      let gone = false;
      deps.realpath = async (path) => {
        if (path === '/work/other') return ROOT;
        if (path === WT && gone) throw Object.assign(new Error('removed folder'), { code: 'ENOENT' });
        return path;
      };
      const owners = { proj: 'ses_owner', other: 'ses_owner' };
      const first = await readAll(deps, THREE_ROWS, owners);
      assert.ok(first.every((inventory) => !inventory.unknown));
      if (startQueued) {
        w.inbox.ses_extra = [];
        w[requests] = [{ sessionID: 'ses_extra' }];
        const second = await readAll(deps, THREE_ROWS, owners);
        assert.ok(second[0].live[0].why.some((why) => /form|permission/.test(why)));
      }
      const pending = priorFor(['proj', 'other'], ['ses_extra'], { requestPending: true });
      gone = true;
      for (let pass = 0; pass < 2; pass++) {
        const before = inboxCalls(w, 'ses_extra');
        const inventories = await readAll(deps, THREE_ROWS, owners, { priorSessions: pending });
        assert.deepEqual(inventories.map((inventory) => !!inventory.unknown), [true, true, false]);
        assert.equal(inboxCalls(w, 'ses_extra'), before + 1, 'the empty inbox is observed but does not establish request absence');
      }
      gone = false;
      w[requests] = [];
      w.inbox.ses_extra = [{ type: 'user' }];
      const reread = await readAll(deps, THREE_ROWS, owners, { priorSessions: pending });
      assert.ok(reread.every((inventory) => !inventory.unknown), 'successful request reads clear the reason');
      assert.deepEqual(reread[0].live.map((s) => s.why), [['input is already queued']]);
      gone = true;
      w.inbox.ses_extra = [];
      const absent = priorFor(['proj', 'other'], ['ses_extra'], { requestPending: false });
      const idle = await readAll(deps, THREE_ROWS, owners, { priorSessions: absent });
      assert.ok(idle.every((inventory) => !inventory.unknown && inventory.live.length === 0), 'verified request absence and an empty inbox leave idle removed history healthy');
    });
  }
}
