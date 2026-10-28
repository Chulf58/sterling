// /sterling:session --window (scripts/open-session-window.mjs, slice 6 of the multi-session toolkit): a session worktree
// gets an OpenCode conductor window in a tmux session of its own, admitted against multi_session.max_sessions.
// Ported from CH.Hub's scripts/tests/open-session-window.test.mjs for the behaviour Sterling keeps. Every test runs
// against a fake tmux and a fake OpenCode server; the folders (and with them the reservation file) are real temp
// folders. No real tmux session or TUI is ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, windowName, terminalCommand, TERMINALS, parseArgs } from '../open-session-window.mjs';
import { admitLaunch, settleLaunch, readReservations, reservationsPath } from '../lib/launch-admission.mjs';
import { takeFileLock } from '../lib/file-lock.mjs';
import { isOpencodeCommand } from '../lib/windows.mjs';
import { sessionName } from '../lib/launchers.mjs';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'open-session-window.mjs');
const BIN = '/home/u/.opencode/bin/opencode';
const SOCKET = '/tmp/tmux-1000/default';
const WORK = '/tmp/tmux-1000/work';
const SERVER_PID = '4242';
const SERVER_START = '1700000000';
const SERVER = { pid: SERVER_PID, start: SERVER_START };
const GUARD = `#{&&:#{==:#{pid},${SERVER_PID}},#{==:#{start_time},${SERVER_START}}}`;
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const notFound = () => ({ code: 1, stdout: '', stderr: 'HTTP 404 Not Found' });
// What tmux 3.4 prints as #{pane_start_command} for a command given as argument words.
const shown = (argv) => argv.map((w) => (/[\s"'\\$`]/.test(w) ? `"${w.replace(/(["\\$`])/g, '\\$1')}"` : w)).join(' ');
const expand = (fmt, vars) => fmt.replace(/#\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : assert.fail(`the fake tmux has no #{${k}}`)));
// The fake runs a guarded command's inner command; the call log keeps the guard for assertions.
const innerCommand = (raw) => {
  assert.equal(raw[0], '-S', `every tmux call names its server: ${raw}`);
  const args = raw.slice(2);
  if (args[0] !== 'if-shell') return args;
  const target = args[3].match(/^set-option -t '(\$\d+)' mouse on$/)?.[1];
  assert.ok(target, `unexpected guarded command: ${args}`);
  return ['set-option', '-t', target, 'mouse', 'on'];
};
const terminalTarget = (args) => args.at(-2).match(/^attach-session -t '(\$\d+)'$/)?.[1] ?? assert.fail(`not a guarded attach: ${args}`);

function world(t, over = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-osw-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ROOT = join(base, 'proj');
  const WT = join(base, 'proj.worktrees');
  const labels = over.labels ?? ['s2', 's3', 's4', 's5', 's6'];
  mkdirSync(ROOT, { recursive: true });
  // Each session worktree carries the Sterling agents open-session's setup installs (anti-pattern 63e3b8c3).
  for (const l of labels) {
    mkdirSync(join(WT, l, '.opencode', 'agents', 'sterling'), { recursive: true });
    writeFileSync(join(WT, l, '.opencode', 'agents', 'sterling', 'conductor.md'), '---\n---\n');
  }
  const S = (l) => join(WT, l);
  const calls = [];
  const state = {
    now: 1_800_000_000_000,
    // The tmux servers by socket: the default one and any other a test brings up.
    servers: new Map(),
    nextPane: 7,
    registered: [ROOT, ...labels.map(S)],
    registry: [{ name: 'proj', repo_path: ROOT }],
    multi: { enabled: true, max_sessions: 9 },
    bin: BIN,
    onPath: { tmux: '/usr/bin/tmux', setsid: '/usr/bin/setsid', ghostty: '/snap/bin/ghostty', 'gnome-terminal': '/usr/bin/gnome-terminal' },
    tty: false,
    env: {},
    platform: 'linux',
    attachAfterMs: 500,
    neverAttach: false,
    paneCmd: undefined,
    inlineExit: 0,
    // OpenCode server state
    sessions: new Map(),
    active: new Set(),
    inbox: new Map(),
    forms: [],
    perms: [],
    apiFail: null,
    ...over.state,
  };
  const srv = (socket) => {
    if (!state.servers.has(socket)) state.servers.set(socket, { up: false, pid: SERVER_PID, start: SERVER_START, sessions: [], nextSession: 0, unreadable: null });
    return state.servers.get(socket);
  };
  // The default server under the names the tests use: state.server (running), state.serverPid, state.tmux (its sessions).
  Object.defineProperty(state, 'server', { get: () => srv(SOCKET).up, set: (v) => { srv(SOCKET).up = v; } });
  Object.defineProperty(state, 'serverPid', { get: () => srv(SOCKET).pid, set: (v) => { srv(SOCKET).pid = v; } });
  Object.defineProperty(state, 'tmux', { get: () => srv(SOCKET).sessions });
  const attachedOf = (s) => (s.attachAt !== undefined && state.now >= s.attachAt ? 1 : s.attached);
  const okT = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const refuse = (stderr) => ({ code: 1, stdout: '', stderr });
  const ids = (sv) => { for (const s of sv.sessions) s.id ??= `$${sv.nextSession++}`; };
  const byTarget = (sv, target) => {
    ids(sv);
    const t2 = target.replace(/:$/, '');
    if (/^\$\d+$/.test(t2)) return sv.sessions.find((s) => s.id === t2);
    if (t2.startsWith('=')) return sv.sessions.find((s) => `=${s.name}` === t2);
    return assert.fail(`the fake tmux was given the target ${JSON.stringify(target)}, which is neither a session id nor an exact name`);
  };
  const rowsOf = (s, fmt) => s.panes.map((p) => expand(fmt, { session_id: s.id, session_name: s.name, pane_id: p.id, pane_pid: String(p.pid), pane_start_command: p.cmd }));
  const tmux = async (raw) => {
    calls.push({ kind: 'tmux', args: raw });
    // Every call yields, so parallel launches interleave as separate processes would.
    await new Promise((r) => setImmediate(r));
    const args = innerCommand(raw);
    const socket = raw[1];
    if (state.onTmux) { const r = await state.onTmux(raw, state, args[0]); if (r) return r; }
    const sv = srv(socket);
    if (sv.unreadable) return refuse(`error connecting to ${socket} (${sv.unreadable})`);
    if (raw[2] === 'if-shell' && raw[4] !== `#{&&:#{==:#{pid},${sv.pid}},#{==:#{start_time},${sv.start}}}`) return { code: 1, stdout: 'server_restarted\n', stderr: '' };
    ids(sv);
    switch (args[0]) {
      case 'list-sessions':
        if (!sv.up) return refuse(`no server running on ${socket}`);
        return okT(sv.sessions.map((s) => `${expand(args[2], { session_id: s.id, session_name: s.name, session_path: s.path, session_attached: String(attachedOf(s)), session_windows: String(s.windows), pid: sv.pid, start_time: sv.start })}\n`).join(''));
      case 'new-session': {
        const opts = {};
        let i = 1;
        for (; i < args.length; i++) {
          if (args[i] === '-d') opts.d = true;
          else if (args[i] === '-P') opts.print = true;
          else if (['-F', '-s', '-c'].includes(args[i])) opts[args[i]] = args[++i];
          else break;
        }
        const command = args.slice(i);
        assert.ok(opts.d && opts['-s'] && opts['-c'] && command.length > 0, `new-session: ${args.join(' ')}`);
        if (sv.sessions.some((x) => x.name === opts['-s'])) return refuse(`duplicate session: ${opts['-s']}`);
        sv.up = true;
        const pane = state.nextPane++;
        const made = { id: `$${sv.nextSession++}`, name: opts['-s'], path: opts['-c'], windows: 1, attached: 0, panes: [{ id: `%${pane}`, pid: 4000 + pane, cmd: state.paneCmd ?? shown(command) }] };
        sv.sessions.push(made);
        return okT(opts.print ? `${expand(opts['-F'], { session_id: made.id, pid: sv.pid, start_time: sv.start })}\n` : '');
      }
      case 'kill-session': {
        const s = byTarget(sv, args[2]);
        if (s) sv.sessions.splice(sv.sessions.indexOf(s), 1);
        return okT();
      }
      case 'set-option':
        return byTarget(sv, args[2]) ? okT() : refuse(`can't find session: ${args[2]}`);
      case 'list-panes': {
        const fmt = args.at(-1);
        if (args[1] === '-a') return sv.up ? okT(sv.sessions.flatMap((s) => rowsOf(s, fmt)).map((r) => `${r}\n`).join('')) : refuse(`no server running on ${socket}`);
        const s = byTarget(sv, args[3]);
        return s ? okT(rowsOf(s, fmt).map((r) => `${r}\n`).join('')) : refuse(`can't find session: ${args[3]}`);
      }
      default:
        return assert.fail(`unexpected tmux command: ${args.join(' ')}`);
    }
  };
  const api = async (method, path) => {
    calls.push({ kind: 'api', method, path });
    assert.equal(method, 'GET', 'the admission only reads');
    if (state.apiFail?.(path)) return { code: 1, stdout: '', stderr: 'HTTP 500 Internal Server Error' };
    const url = new URL(path, 'http://x');
    const p = url.pathname;
    const loc = url.searchParams.get('location[directory]');
    if (p === '/api/session') return ok({ data: [...state.sessions.values()], cursor: { next: null } });
    if (p === '/api/session/active') return ok({ data: Object.fromEntries([...state.active].map((id) => [id, {}])) });
    if (p === '/api/form') return ok({ data: state.forms.filter((f) => f.dir === loc) });
    if (p === '/api/permission/request') return ok({ data: state.perms.filter((f) => f.dir === loc) });
    let m = /^\/api\/session\/(ses_[A-Za-z0-9]+)$/.exec(p);
    if (m) return state.sessions.has(m[1]) ? ok({ data: state.sessions.get(m[1]) }) : notFound();
    m = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/inbox$/.exec(p);
    if (m) return state.sessions.has(m[1]) ? ok({ data: state.inbox.get(m[1]) ?? [] }) : notFound();
    throw new Error(`unexpected request ${method} ${path}`);
  };
  let clock = 10;
  const conductor = (id, dir, extra = {}) => {
    clock += 10;
    state.sessions.set(id, { id, parentID: null, agent: 'sterling/conductor', location: { directory: dir }, time: { created: clock, updated: clock }, ...extra });
    return id;
  };
  const deps = {
    platform: state.platform,
    uid: 1000,
    env: state.env,
    isTTY: state.tty,
    now: () => state.now,
    sleep: async (ms) => { state.now += ms; },
    realpath: (p) => realpath(p),
    readdir: (dir) => readdir(dir),
    gitWorktrees: async () => state.registered,
    exists: (p) => existsSync(p),
    listProjects: async () => state.registry,
    readMultiSession: () => state.multi,
    resolveMain: (target) => {
      if (target === 'nope') throw Object.assign(new Error("REFUSED: --target 'nope' is neither a directory nor a registered project"), { exit: 2 });
      return ROOT;
    },
    opencodeBin: () => state.bin,
    findExecutable: (name) => state.onPath[name] ?? null,
    tmux,
    api,
    admit: admitLaunch,
    settle: settleLaunch,
    spawnTerminal: async (file, args, opts) => {
      calls.push({ kind: 'spawn', file, args, opts });
      const s = byTarget(srv(args[args.indexOf('-S') + 1]), terminalTarget(args));
      if (s && !state.neverAttach) s.attachAt = state.now + state.attachAfterMs;
    },
    attachInline: async (target, socket, server) => {
      calls.push({ kind: 'attach', target, socket, server });
      const s = byTarget(srv(socket), target);
      if (!s) return 1;
      s.attached = 1;
      return state.inlineExit;
    },
  };
  return { base, ROOT, WT, S, deps, state, calls, conductor, srv };
}

async function launch(w, ...argv) {
  w.deps.isTTY = w.state.tty;
  w.deps.platform = w.state.platform;
  const out = [];
  const err = [];
  const code = await main(argv, w.deps, { stdout: (s) => { w.calls.push({ kind: 'stdout' }); out.push(s); }, stderr: (s) => err.push(s) });
  assert.deepEqual(w.calls.filter((c) => c.kind === 'tmux' && innerCommand(c.args)[0] === 'kill-session').map((c) => c.args), [], 'this launcher never kills a session');
  const text = out.join('');
  return { code, text, err: err.join(''), json: text ? JSON.parse(text.trim().split('\n').at(-1)) : null };
}

const open = (w, label = 's2', ...extra) => launch(w, '--name', label, '--detached', ...extra);
const tmuxCalls = (w, verb) => w.calls.filter((c) => c.kind === 'tmux' && innerCommand(c.args)[0] === verb).map((c) => c.args);
const effects = (w) => w.calls.filter((c) => (c.kind === 'tmux' && ['new-session', 'set-option', 'attach-session', 'kill-session', 'send-keys'].includes(innerCommand(c.args)[0])) || c.kind === 'spawn' || c.kind === 'attach');
const reservations = (w) => (existsSync(reservationsPath(w.ROOT)) ? readReservations(w.ROOT).reservations : []);
// The main checkout's own sterling-launch.sh window: a hand-opened session the ceiling counts.
const mainWindow = (w) => {
  w.state.server = true;
  w.state.tmux.push({ name: `${sessionName(w.ROOT)}-opencode`, path: w.ROOT, attached: 1, windows: 1, panes: [{ id: '%1', pid: 100, cmd: BIN }] });
};

// --- the name and the window ---

test('the window is named as the checkout\'s own launcher names its OpenCode session, distinct per checkout, with no dot or colon', () => {
  const names = ['/a/p.worktrees/s2', '/a/p.worktrees/s3', '/b/p.worktrees/s2', '/a/p.worktrees/s.2'].map(windowName);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.doesNotMatch(n, /[.:]/);
  for (const f of ['/a/p.worktrees/s2', '/x/My Proj.worktrees/lab_1']) assert.equal(windowName(f), `${sessionName(f)}-opencode`);
});

test('a session worktree gets its own tmux session in that folder, running OpenCode directly, mouse on behind the pid guard, and a started reservation', async (t) => {
  const w = world(t);
  const r = await open(w);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.status, 'started');
  assert.deepEqual(tmuxCalls(w, 'new-session'), [['-S', SOCKET, 'new-session', '-d', '-P', '-F', '#{session_id}\t#{pid}\t#{start_time}', '-s', windowName(w.S('s2')), '-c', w.S('s2'), BIN]]);
  const set = w.calls.filter((c) => c.kind === 'tmux' && c.args[2] === 'if-shell');
  assert.deepEqual(set.map((c) => c.args), [['-S', SOCKET, 'if-shell', '-F', GUARD, `set-option -t '${r.json.windowId}' mouse on`, `display-message -p server_restarted ; run-shell 'exit 1'`]]);
  assert.deepEqual([r.json.socket, r.json.serverPid, r.json.attached], [SOCKET, SERVER_PID, false]);
  assert.match(r.json.note, /tmux -S '\/tmp\/tmux-1000\/default' attach-session -t '\$0'/);
  const [res] = reservations(w);
  assert.deepEqual([res.checkout, res.state, res.detail.windowId, res.holder], [w.S('s2'), 'started', r.json.windowId, null]);
  assert.ok(isOpencodeCommand(w.state.tmux[0].panes[0].cmd));
});

test('--session resumes that conductor session: opencode --session <id>, also while it is live itself', async (t) => {
  const w = world(t);
  const id = w.conductor('ses_resume1', w.S('s2'));
  w.state.active.add(id);
  const r = await open(w, 's2', '--session', id);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(tmuxCalls(w, 'new-session')[0].slice(-3), [BIN, '--session', id]);
  assert.ok(isOpencodeCommand(w.state.tmux[0].panes[0].cmd));
});

test('--checkout through a link starts the window in the real folder', async (t) => {
  const w = world(t);
  const link = join(w.base, 'link-s2');
  symlinkSync(w.S('s2'), link);
  const r = await launch(w, '--checkout', link, '--detached');
  assert.equal(r.code, 0, r.err);
  assert.equal(tmuxCalls(w, 'new-session')[0][10], w.S('s2'));
});

// --- refusals: nothing is started, nothing is reserved ---

test('every folder that is not a registered session worktree of the project is refused and nothing is started', async (t) => {
  const w = world(t);
  mkdirSync(join(w.WT, 'loose'));
  mkdirSync(join(w.ROOT, 'sub'));
  w.state.registered = w.state.registered.filter((p) => p !== w.S('s6'));
  const cases = [
    [['--checkout', w.ROOT], 'main_checkout', 1],
    [['--checkout', join(w.ROOT, 'sub')], 'main_checkout', 1],
    [['--name', 'gone'], 'checkout_missing', 1],
    [['--name', 'loose'], 'not_a_session_checkout', 1],
    [['--name', 's6'], 'not_a_session_checkout', 1],
  ];
  for (const [argv, reason, code] of cases) {
    const r = await launch(w, ...argv, '--detached');
    assert.deepEqual([r.code, r.json.status, r.json.reason], [code, 'refused', reason], `${argv}: ${r.text}`);
  }
  assert.deepEqual(effects(w), []);
  assert.deepEqual(reservations(w), []);
});

test('a worktree without .opencode/agents/sterling/conductor.md is refused: OpenCode would not find the conductor there', async (t) => {
  const w = world(t);
  rmSync(join(w.S('s2'), '.opencode'), { recursive: true });
  const r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'agents_missing']);
  assert.match(r.json.why, /63e3b8c3/);
  assert.deepEqual(effects(w), []);
});

test('multi_session off is exit 2 naming multi_session.enabled; another platform and a missing tmux are refused loudly', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: false, max_sessions: 1 };
  let r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [2, 'multi_session_off']);
  assert.match(r.json.why, /multi_session\.enabled/);
  w.state.multi = { enabled: true, max_sessions: 3 };
  w.state.platform = 'darwin';
  r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'unsupported_platform']);
  w.state.platform = 'linux';
  delete w.state.onPath.tmux;
  r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'no_tmux']);
  assert.deepEqual(effects(w), []);
});

test('an unregistered project, a bad --target and bad arguments exit 2 with nothing started', async (t) => {
  const w = world(t);
  for (const argv of [['--name', 's2', '--checkout', '/x'], ['--name', 'a b'], ['--checkout', 'rel'], ['--name', 's2', '--session', 'nope'], ['--name', 's2', '--attach-timeout', '0'], ['--bogus'], ['--name', 's2', '--name', 's3']]) {
    const r = await launch(w, ...argv);
    assert.deepEqual([r.code, r.json.status], [2, 'failed'], `${argv}`);
  }
  let r = await launch(w, '--target', 'nope', '--name', 's2');
  assert.deepEqual([r.code, r.json.status], [2, 'failed']);
  w.state.registry = [{ name: 'other', repo_path: w.base }];
  r = await open(w);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /not a registered Sterling project/);
  assert.deepEqual(effects(w), []);
});

test('an existing tmux session of that name or of that folder refuses the launch, attached or not, and is never attached to', async (t) => {
  for (const stray of [{ name: 'x-other', path: 'S2' }, { name: 'NAME', path: 'ELSE' }]) {
    const w = world(t);
    w.state.server = true;
    w.state.tmux.push({ name: stray.name === 'NAME' ? windowName(w.S('s2')) : stray.name, path: stray.path === 'S2' ? w.S('s2') : w.base, attached: 0, windows: 1, panes: [{ id: '%2', pid: 200, cmd: 'bash' }] });
    const r = await open(w);
    assert.deepEqual([r.code, r.json.reason], [1, 'window_exists']);
    assert.deepEqual(effects(w), []);
  }
});

test('a missing or unrecognisable OpenCode binary and a missing terminal are refused before anything is created', async (t) => {
  const w = world(t);
  w.state.bin = 'opencode';
  let r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'opencode_binary']);
  w.state.bin = '/usr/bin/opencode2';
  r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'opencode_binary']);
  w.state.bin = BIN;
  w.state.onPath = { tmux: '/usr/bin/tmux' };
  r = await launch(w, '--name', 's2');
  assert.deepEqual([r.code, r.json.reason], [1, 'no_terminal']);
  assert.deepEqual(effects(w), []);
});

test('a bare OPENCODE_BIN is resolved on PATH to an absolute path before tmux sees it', async (t) => {
  const w = world(t);
  w.state.bin = 'opencode';
  w.state.onPath.opencode = BIN;
  const r = await open(w);
  assert.equal(r.code, 0, r.err);
  assert.equal(tmuxCalls(w, 'new-session')[0].at(-1), BIN);
});

// --- admission through the OpenCode API ---

test('a blank launch is refused while a conductor of the checkout is live, whatever makes it live, and nothing is started', async (t) => {
  for (const make of ['active', 'inbox', 'form', 'perm']) {
    const w = world(t);
    const id = w.conductor('ses_live1', w.S('s2'));
    if (make === 'active') w.state.active.add(id);
    if (make === 'inbox') w.state.inbox.set(id, [{ id: 'q1', text: 'hi', time: { created: 1 } }]);
    if (make === 'form') w.state.forms.push({ id: 'f1', sessionID: id, dir: w.S('s2') });
    if (make === 'perm') w.state.perms.push({ id: 'p1', sessionID: id, dir: w.S('s2') });
    const r = await open(w);
    assert.deepEqual([r.code, r.json.reason], [1, 'conductor_live'], `${make}: ${r.text}`);
    assert.deepEqual(r.json.conductors.map((c) => c.id), [id]);
    assert.deepEqual(effects(w), []);
    assert.deepEqual(reservations(w), []);
  }
});

test('an incomplete inventory refuses as conductor_unknown: an unknown state is never a free checkout', async (t) => {
  const w = world(t);
  w.state.apiFail = (p) => p === '/api/session/active';
  const r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'conductor_unknown']);
  assert.deepEqual(effects(w), []);
});

test('--session is refused unless that session is a top-level conductor that runs in this checkout', async (t) => {
  const w = world(t);
  w.conductor('ses_sub1', w.S('s2'), { parentID: 'ses_parent1' });
  w.conductor('ses_parent1', w.S('s2'));
  w.conductor('ses_worker1', w.S('s2'), { agent: 'sterling/implementor' });
  w.conductor('ses_other1', w.S('s3'));
  for (const [id, reason] of [['ses_missing1', 'session_not_found'], ['ses_sub1', 'session_not_conductor'], ['ses_worker1', 'session_not_conductor'], ['ses_other1', 'session_other_checkout']]) {
    const r = await open(w, 's2', '--session', id);
    assert.deepEqual([r.code, r.json.reason], [1, reason], id);
  }
  w.state.apiFail = (p) => p === '/api/session/ses_parent1';
  const r = await open(w, 's2', '--session', 'ses_parent1');
  assert.equal(r.json.reason, 'conductor_unknown');
  assert.deepEqual(effects(w), []);
});

test('--session is refused while another conductor of the checkout is live: resuming one would make two', async (t) => {
  const w = world(t);
  const mine = w.conductor('ses_mine1', w.S('s2'));
  w.state.active.add(w.conductor('ses_twin1', w.S('s2')));
  const r = await open(w, 's2', '--session', mine);
  assert.deepEqual([r.code, r.json.reason], [1, 'conductor_live']);
});

test('the admission reads the API only before the session is created and never writes to it', async (t) => {
  const w = world(t);
  await open(w);
  const firstCreate = w.calls.findIndex((c) => c.kind === 'tmux' && innerCommand(c.args)[0] === 'new-session');
  assert.ok(w.calls.slice(firstCreate).every((c) => c.kind !== 'api'));
  assert.ok(w.calls.filter((c) => c.kind === 'api').every((c) => c.method === 'GET'));
});

// --- the ceiling ---

test('hand-opened sessions are counted but only this launcher refuses: with the main window open, max_sessions=2 admits one more and refuses the next', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 2 };
  mainWindow(w);
  let r = await open(w, 's2');
  assert.equal(r.json.status, 'started', r.text);
  r = await open(w, 's3');
  assert.deepEqual([r.code, r.json.reason], [1, 'ceiling_reached']);
  assert.deepEqual(r.json.counted.map((c) => c.checkout).sort(), [w.ROOT, w.S('s2')].sort());
  assert.equal(tmuxCalls(w, 'new-session').length, 1);
  // A live conductor in a plain terminal (no window) counts too.
  const w2 = world(t);
  w2.state.multi = { enabled: true, max_sessions: 1 };
  w2.state.active.add(w2.conductor('ses_hand1', w2.S('s4')));
  r = await open(w2, 's2');
  assert.equal(r.json.reason, 'ceiling_reached');
  assert.match(r.json.why, /live conductor ses_hand1/);
});

test('N parallel launches against max_sessions=k start exactly k windows; the others are ceiling_reached and start nothing', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 3 };
  const results = await Promise.all(['s2', 's3', 's4', 's5', 's6'].map((l) => open(w, l)));
  assert.equal(results.filter((r) => r.json.status === 'started').length, 3, results.map((r) => r.text).join(''));
  assert.deepEqual(results.filter((r) => r.json.status !== 'started').map((r) => r.json.reason), ['ceiling_reached', 'ceiling_reached']);
  assert.equal(tmuxCalls(w, 'new-session').length, 3);
  assert.equal(w.state.tmux.length, 3);
});

test('an uncertain start stays counted: a later launch meets the ceiling, and the same checkout is launch_in_progress', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 1 };
  w.state.onTmux = (raw, _s, verb) => (verb === 'new-session' ? { code: null, stdout: '', stderr: 'timed out' } : null);
  let r = await open(w, 's2');
  assert.deepEqual([r.code, r.json.status], [1, 'start_uncertain']);
  assert.match(r.json.note, /stays counted against max_sessions/);
  assert.deepEqual(reservations(w).map((x) => [x.checkout, x.state]), [[w.S('s2'), 'uncertain']]);
  w.state.onTmux = null;
  r = await open(w, 's3');
  assert.equal(r.json.reason, 'ceiling_reached');
  w.state.multi = { enabled: true, max_sessions: 5 };
  r = await open(w, 's2');
  assert.equal(r.json.reason, 'launch_in_progress');
});

test('an unconfirmed creation keeps any partial identity and asks for inspection before any retry', async (t) => {
  const w = world(t);
  w.state.onTmux = (raw, _s, verb) => (verb === 'new-session' ? { code: 1, stdout: '$9\t4242\t1700000000\n', stderr: 'lost connection' } : null);
  const r = await open(w);
  assert.equal(r.json.status, 'start_uncertain');
  assert.deepEqual([r.json.windowId, r.json.serverPid, r.json.serverStart, r.json.socket, r.json.creationOutput], ['$9', '4242', SERVER_START, SOCKET, '$9\t4242\t1700000000\n']);
  assert.match(r.err, /inspect the server shown by tmux -S/);
  assert.equal(tmuxCalls(w, 'new-session').length, 1, 'never retried');
});

test('definite duplicate-name and bad-argument rejections are ordinary failures and release the reservation', async (t) => {
  for (const stderr of ['duplicate session: x', 'usage: new-session [-AdDEPX]', 'command new-session: unknown flag -Q']) {
    const w = world(t);
    w.state.onTmux = (raw, _s, verb) => (verb === 'new-session' ? { code: 1, stdout: '', stderr } : null);
    const r = await open(w);
    assert.deepEqual([r.code, r.json.status], [1, 'failed'], stderr);
    assert.deepEqual(reservations(w), []);
  }
});

test('a tmux runner that throws during the creation is an uncertain start: the reservation is kept, never released', async (t) => {
  const w = world(t);
  w.state.onTmux = (raw, _s, verb) => (verb === 'new-session' ? (() => { throw new Error('spawn failed'); })() : null);
  const r = await open(w);
  assert.equal(r.json.status, 'start_uncertain');
  assert.equal(reservations(w).length, 1);
});

test('a new-session answer that is not a session id and server pid leaves the session as it is, unverified and counted', async (t) => {
  for (const out of ['sterling-x:\n', '$3\t\n']) {
    const w = world(t);
    w.state.onTmux = (raw, _s, verb) => (verb === 'new-session' ? (w.state.server = true, { code: 0, stdout: out, stderr: '' }) : null);
    const r = await open(w);
    assert.deepEqual([r.code, r.json.status], [1, 'started_unverified']);
    assert.deepEqual(reservations(w).map((x) => x.state), ['uncertain']);
    assert.deepEqual(effects(w).filter((c) => c.kind !== 'tmux' || innerCommand(c.args)[0] !== 'new-session'), []);
  }
});

// --- after the creation: by id, behind the guard, never killed ---

test('a session for the same checkout that appears just before new-session is a window_conflict: both are left running, nothing is killed or attached', async (t) => {
  const w = world(t);
  w.state.onTmux = (raw, s, verb) => {
    if (verb === 'new-session' && !s.raced) {
      s.raced = true;
      s.server = true;
      s.tmux.push({ name: 'sterling-stray-opencode', path: w.S('s2'), attached: 1, windows: 1, panes: [{ id: '%2', pid: 200, cmd: BIN }] });
    }
    return null;
  };
  const r = await launch(w, '--name', 's2');
  assert.deepEqual([r.code, r.json.reason, r.json.killed], [1, 'window_conflict', false]);
  assert.equal(w.state.tmux.length, 2);
  assert.match(r.json.why, /tmux -S '\/tmp\/tmux-1000\/default' kill-session -t/);
  assert.deepEqual(w.calls.filter((c) => c.kind === 'spawn' || c.kind === 'attach'), []);
  assert.deepEqual(reservations(w).map((x) => x.state), ['started']);
});

test('a restarted server at the same socket refuses the mouse configuration and anything after it, also when it reuses the pid', async (t) => {
  for (const restart of [(sv) => { sv.pid = '777'; }, (sv) => { sv.start = '1700000999'; }]) {
    const w = world(t);
    // Restarted between the creation and the guarded mouse configuration: same socket and ids, another server.
    w.state.onTmux = (raw, s, verb) => {
      if (verb === 'set-option') restart(w.srv(SOCKET));
      return null;
    };
    const r = await launch(w, '--name', 's2');
    assert.deepEqual([r.code, r.json.reason], [1, 'server_restarted']);
    assert.deepEqual(w.calls.filter((c) => c.kind === 'spawn' || c.kind === 'attach'), []);
    assert.deepEqual(reservations(w).map((x) => x.state), ['uncertain']);
  }
});

test('inside a tmux server that is not the default one, the window is created on that server with -S, and the reservation records it', async (t) => {
  const w = world(t, { state: { env: { TMUX: `${WORK},999,3` } } });
  const r = await open(w);
  assert.equal(r.json.status, 'started', r.text);
  assert.equal(r.json.socket, WORK);
  assert.deepEqual(tmuxCalls(w, 'new-session')[0].slice(0, 3), ['-S', WORK, 'new-session']);
  assert.equal(w.srv(WORK).sessions.length, 1);
  assert.equal(w.state.tmux.length, 0);
  assert.deepEqual(reservations(w).map((x) => [x.socket, x.state, x.expires_at]), [[WORK, 'started', null]]);
});

test('a window whose pane is not OpenCode after the start, or that is gone at once, is reported and left as it is', async (t) => {
  const w = world(t);
  w.state.paneCmd = 'bash';
  let r = await open(w);
  assert.equal(r.json.status, 'started_unverified');
  assert.match(r.json.error, /does not hold exactly one OpenCode pane/);
  const w2 = world(t);
  w2.state.onTmux = (raw, s, verb) => {
    if (verb === 'new-session') s.created = true;
    // OpenCode exited at once: the session is gone by the first listing after the creation.
    else if (verb === 'list-sessions' && s.created) s.tmux.length = 0;
    return null;
  };
  r = await open(w2);
  assert.equal(r.json.status, 'started_unverified');
  assert.match(r.json.error, /not listed right after it was created/);
});

test('every tmux call after the creation names the session by its id, never by its name', async (t) => {
  const w = world(t);
  await launch(w, '--name', 's2');
  const after = w.calls.slice(w.calls.findIndex((c) => c.kind === 'tmux' && innerCommand(c.args)[0] === 'new-session') + 1).filter((c) => c.kind === 'tmux' || c.kind === 'spawn');
  assert.ok(after.length > 0);
  for (const c of after) assert.doesNotMatch(JSON.stringify(c.args), new RegExp(windowName(w.S('s2'))), JSON.stringify(c.args));
});

// --- showing the window ---

test('with no terminal around, a terminal emulator is opened without TMUX, attaching with -S and the guard, and the run waits for it', async (t) => {
  const w = world(t, { state: { env: { TMUX: '/tmp/tmux-1000/work,1,0', TMUX_PANE: '%3', KEEP: '1' } } });
  const r = await launch(w, '--name', 's2');
  assert.deepEqual([r.code, r.json.status, r.json.attached, r.json.attach], [0, 'started', true, 'terminal:ghostty']);
  const [spawned] = w.calls.filter((c) => c.kind === 'spawn');
  assert.equal(spawned.file, 'setsid');
  assert.deepEqual(spawned.args.slice(0, 4), ['-f', '/snap/bin/ghostty', `--working-directory=${w.S('s2')}`, '-e']);
  // The launch runs inside the tmux server at WORK, so the window is created and attached there.
  assert.deepEqual(spawned.args.slice(-7), ['-S', WORK, 'if-shell', '-F', GUARD, `attach-session -t '${r.json.windowId}'`, `display-message -p server_restarted ; run-shell 'exit 1'`]);
  assert.deepEqual(spawned.opts.env, { KEEP: '1' });
});

test('the terminal emulators are tried in order and each gets its own arguments', () => {
  assert.deepEqual(TERMINALS, ['ghostty', 'gnome-terminal', 'kitty', 'konsole', 'x-terminal-emulator']);
  const lead = (t) => terminalCommand(t, '/w', SOCKET, '$1', '9').slice(0, 3);
  assert.deepEqual(lead('gnome-terminal'), ['--working-directory=/w', '--', 'bash']);
  assert.deepEqual(lead('kitty'), ['--directory', '/w', 'bash']);
  assert.deepEqual(lead('konsole'), ['--workdir', '/w', '-e']);
  assert.deepEqual(lead('x-terminal-emulator'), ['-e', 'bash', '-c']);
});

test('a terminal that never attaches leaves the session running and says so, exit 1', async (t) => {
  const w = world(t, { state: { neverAttach: true } });
  const r = await launch(w, '--name', 's2', '--attach-timeout', '3');
  assert.deepEqual([r.code, r.json.status], [1, 'started_unattached']);
  assert.equal(w.state.tmux.length, 1);
});

test('on a terminal outside tmux the window is attached right there after the result is printed, with -S and the server pid', async (t) => {
  const w = world(t, { state: { tty: true } });
  const r = await launch(w, '--name', 's2');
  assert.equal(r.code, 0, r.err);
  const printed = w.calls.findIndex((c) => c.kind === 'stdout');
  const attached = w.calls.findIndex((c) => c.kind === 'attach');
  assert.ok(printed >= 0 && attached > printed);
  assert.deepEqual(w.calls[attached], { kind: 'attach', target: r.json.windowId, socket: SOCKET, server: SERVER });
});

test('--dry-run reads and checks everything, the ceiling included, and starts and reserves nothing', async (t) => {
  const w = world(t);
  let r = await launch(w, '--name', 's2', '--dry-run', '--detached');
  assert.deepEqual([r.code, r.json.status], [0, 'would_start']);
  assert.deepEqual(r.json.tmux.slice(0, 10), ['-S', SOCKET, 'new-session', '-d', '-P', '-F', '#{session_id}\t#{pid}\t#{start_time}', '-s', windowName(w.S('s2')), '-c']);
  w.state.multi = { enabled: true, max_sessions: 1 };
  mainWindow(w);
  r = await launch(w, '--name', 's2', '--dry-run', '--detached');
  assert.equal(r.json.reason, 'ceiling_reached');
  assert.deepEqual(effects(w), []);
  assert.equal(existsSync(reservationsPath(w.ROOT)), false);
});

// --- source pins ---

test('open-session-window.mjs never sends kill-session and runs every post-creation mutation behind the shared guard', () => {
  const src = readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, '').replace(/`[^`]*kill-session[^`]*`/g, ''), /kill-session/);
  assert.doesNotMatch(src, /'(?:set-option|attach-session|send-keys|kill-server)'/, 'mutations go through guardedCommand strings only');
  assert.match(src, /from '\.\/lib\/windows\.mjs'/);
  assert.doesNotMatch(src, /const isOpencodeCommand/);
});

test('parseArgs is the shared exact-token parser: --flag=value works, a repeated flag or an empty value refuses', () => {
  assert.equal(parseArgs(['--name', 's2']).name, 's2');
  const eq = parseArgs(['--name=s2', '--attach-timeout=5', '--dry-run']);
  assert.deepEqual([eq.name, eq.attachTimeout, eq.dryRun], ['s2', 5, true]);
  assert.throws(() => parseArgs(['--name', 's2', '--name=s3']), /more than once/);
  assert.throws(() => parseArgs(['--name', 's2', '--detached', '--detached']), /more than once/);
  assert.throws(() => parseArgs(['--name=']), /needs a value/);
  assert.throws(() => parseArgs(['--name', '--detached']), /looks like another flag/);
  assert.throws(() => parseArgs(['--dry-run=yes', '--name', 's2']), /takes no value/);
  assert.throws(() => parseArgs([]), /exactly one of --name and --checkout/);
});

// --- review fixes: evidence read inside the lock, every server that matters ---

// Holds the admission lock while `during` changes the world, so the launch waits at the lock with its pre-lock reads done.
async function duringLockWait(w, during, ...argv) {
  const release = await takeFileLock(`${reservationsPath(w.ROOT)}.lock`);
  let entered;
  const atLock = new Promise((r) => { entered = r; });
  const admit = w.deps.admit;
  w.deps.admit = (...a) => { entered(); return admit(...a); };
  const run = launch(w, ...argv);
  await atLock;
  await new Promise((r) => setTimeout(r, 30));
  during();
  release();
  return run;
}

test('a hand-opened conductor that becomes live while the launch waits for the lock is counted: max_sessions=1 refuses', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 1 };
  const r = await duringLockWait(w, () => w.state.active.add(w.conductor('ses_hand1', w.S('s4'))), '--name', 's2', '--detached');
  assert.deepEqual([r.code, r.json.reason], [1, 'ceiling_reached'], r.text);
  assert.match(r.json.why, /live conductor ses_hand1/);
  assert.deepEqual(tmuxCalls(w, 'new-session'), []);
});

test('a conductor of the target that becomes live while the launch waits for the lock refuses it as conductor_live', async (t) => {
  const w = world(t);
  const r = await duringLockWait(w, () => w.state.active.add(w.conductor('ses_twin2', w.S('s2'))), '--name', 's2', '--detached');
  assert.deepEqual([r.code, r.json.reason], [1, 'conductor_live'], r.text);
  assert.deepEqual(tmuxCalls(w, 'new-session'), []);
});

test('the ceiling is project-wide across tmux servers: a window started on another socket stays counted, past any TTL, until it is gone there', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 1 };
  w.deps.env = { TMUX: `${WORK},999,3` };
  let r = await open(w, 's2');
  assert.deepEqual([r.json.status, r.json.socket], ['started', WORK], r.text);
  w.deps.env = {};
  w.state.now += 7 * 24 * 3600_000;
  r = await open(w, 's3');
  assert.deepEqual([r.code, r.json.reason], [1, 'ceiling_reached'], r.text);
  assert.ok(r.json.counted.some((c) => c.checkout === w.S('s2')));
  // Its window is gone from ITS server: the reservation is dropped and the next launch is admitted.
  w.srv(WORK).sessions.length = 0;
  r = await open(w, 's3');
  assert.equal(r.json.status, 'started', r.text);
  assert.deepEqual(reservations(w).map((x) => [x.checkout, x.socket]), [[w.S('s3'), SOCKET]]);
});

test('an idle main window on the default server is counted when the launch runs inside another tmux server', async (t) => {
  const w = world(t);
  w.state.multi = { enabled: true, max_sessions: 1 };
  mainWindow(w);
  w.state.tmux[0].attached = 0;
  w.deps.env = { TMUX: `${WORK},999,3` };
  const r = await open(w, 's2');
  assert.deepEqual([r.code, r.json.reason], [1, 'ceiling_reached'], r.text);
  assert.ok(r.json.why.includes(`on ${SOCKET}`), r.json.why);
});

test('a recorded socket that cannot be read refuses the launch loudly instead of counting it as empty', async (t) => {
  const w = world(t);
  w.deps.env = { TMUX: `${WORK},999,3` };
  assert.equal((await open(w, 's2')).json.status, 'started');
  w.deps.env = {};
  w.srv(WORK).unreadable = 'Permission denied';
  const r = await open(w, 's3');
  assert.deepEqual([r.code, r.json.reason, r.json.socket], [1, 'tmux_unreadable', WORK], r.text);
  assert.equal(tmuxCalls(w, 'new-session').length, 1);
});

test('a malformed TMUX refuses rather than guessing the server', async (t) => {
  const w = world(t, { state: { env: { TMUX: 'nonsense' } } });
  const r = await open(w);
  assert.deepEqual([r.code, r.json.reason], [1, 'tmux_unreadable']);
  assert.deepEqual(effects(w), []);
});
