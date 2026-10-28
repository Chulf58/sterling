// A fake OpenCode server and machine for the wake-project / notify-project tests (multi-session toolkit
// slice 3). Each world owns its temp folders: a target project with one session worktree and a sender
// project, both real folders, so the owner records and the delivery journal are real files.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readOwner, transitionOwner, recordOwner } from '../../lib/owner-record.mjs';
import { deliveryJournal } from '../../lib/delivery-journal.mjs';

const notFound = (body = '') => ({ code: 1, stdout: body, stderr: 'HTTP 404 Not Found' });
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

export function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-ms-')));
  const ROOT = join(base, 'proj');
  const WT = join(base, 'proj.worktrees', 'lane');
  const SENDER = join(base, 'sender');
  const OTHER = join(base, 'other');
  for (const d of [ROOT, WT, SENDER, OTHER]) mkdirSync(join(d, '.sterling'), { recursive: true });
  let clock = 1_000_000;
  const w = {
    base, ROOT, WT, SENDER, OTHER,
    registry: [{ name: 'proj', repo_path: ROOT }, { name: 'sender', repo_path: SENDER }, { name: 'other', repo_path: OTHER }],
    sessions: new Map(),
    active: new Set(),
    inbox: new Map(),
    messages: new Map(),
    forms: [],
    perms: [],
    shells: new Map(),
    removed: new Set(),
    processes: [],
    posts: [],
    calls: [],
    multi: new Map([[ROOT, true], [OTHER, true], [SENDER, true]]),
    // A hook run before each GET answer: tests change the world mid-run with it.
    onGet: null,
    sendResult: null,
    onPrepare: null,
    discarded: 0,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  w.session = (id, { parent, dir = ROOT, agent, archived, created } = {}) => {
    clock += 10;
    w.sessions.set(id, { id, parentID: parent ?? null, agent, location: { directory: dir }, time: { created: created ?? clock, updated: clock, ...(archived ? { archived: clock } : {}) } });
    return id;
  };
  w.setOwner = (checkout, id) => transitionOwner(checkout, { expect: readOwner(checkout)?.session ?? null, next: id });
  w.api = async (method, path) => {
    w.calls.push(`${method} ${path}`);
    if (w.onGet) await w.onGet(path, w);
    const url = new URL(path, 'http://x');
    const p = url.pathname;
    const loc = url.searchParams.get('location[directory]');
    if (p === '/api/session') return ok({ data: [...w.sessions.values()], cursor: { next: null } });
    if (p === '/api/session/active') return ok({ data: Object.fromEntries([...w.active].map((id) => [id, {}])) });
    if (p === '/api/form') return ok({ data: w.forms.filter((f) => f.dir === loc) });
    if (p === '/api/permission/request') return ok({ data: w.perms.filter((f) => f.dir === loc) });
    if (p === '/api/shell') {
      if (w.shellError?.has(loc)) return { code: 1, stdout: '', stderr: 'HTTP 500 Internal Server Error' };
      if (w.removed.has(loc)) return notFound(JSON.stringify({ _tag: 'LocationNotFoundError' }));
      return ok({ location: {}, data: w.shells.get(loc) ?? [] });
    }
    let m = /^\/api\/session\/(ses_[A-Za-z0-9]+)$/.exec(p);
    if (m) return w.sessions.has(m[1]) ? ok({ data: w.sessions.get(m[1]) }) : notFound();
    m = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/inbox$/.exec(p);
    if (m) return w.sessions.has(m[1]) ? ok({ data: w.inbox.get(m[1]) ?? [] }) : notFound();
    m = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/message\/(msg_[A-Za-z0-9]+)$/.exec(p);
    if (m) return (w.messages.get(m[1]) ?? []).some((x) => x.id === m[2]) ? ok({ data: { id: m[2] } }) : notFound();
    throw new Error(`unexpected request ${method} ${path}`);
  };
  // The server dedupes a prompt by its message id (finding 0ded033d).
  w.send = async (method, path, body) => {
    w.posts.push({ method, path, body });
    const session = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/prompt$/.exec(path)?.[1];
    if (w.sendResult) return w.sendResult(body, session, w);
    w.land(session, body);
    return { ok: true, data: { data: { id: body.id, sessionID: session, type: 'user', delivery: 'queue' } } };
  };
  w.land = (session, body) => {
    const list = w.messages.get(session) ?? [];
    if (!list.some((x) => x.id === body.id)) list.push({ id: body.id, text: body.text });
    w.messages.set(session, list);
  };
  w.deps = (over = {}) => ({
    api: w.api,
    // The prepared POST: preparation may run a test's hook (a wait), send() posts at once.
    prepareSend: async (method, path, body) => {
      w.calls.push('prepare');
      if (w.onPrepare) await w.onPrepare(w);
      let used = false;
      return {
        send: () => { used = true; w.calls.push('POST'); return w.send(method, path, body); },
        discard: async () => { if (!used) w.discarded += 1; used = true; },
      };
    },
    realpath: (p) => realpath(p),
    readdir: async (dir) => (dir === join(base, 'proj.worktrees') ? ['lane'] : []),
    gitWorktrees: async () => [ROOT, WT],
    processCwds: async () => w.processes,
    now: () => clock,
    listProjects: async () => w.registry,
    readOwner,
    transitionOwner,
    readMultiSession: (root) => ({ enabled: w.multi.get(root) ?? false, max_sessions: 1, source: 'config' }),
    runLock: async () => async () => {},
    senderRoot: SENDER,
    cwd: ROOT,
    journal: () => deliveryJournal(SENDER),
    ...over,
  });
  w.io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; } }, json: () => out.stdout.trim().split('\n').map((l) => JSON.parse(l)) };
  };
  w.journalRecords = () => Object.values(deliveryJournal(SENDER).load().records);
  return w;
}

export { readOwner, transitionOwner, recordOwner };
