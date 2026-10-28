// The shared core of wake-project and notify-project (multi-session toolkit slice 3, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session): which checkout a run is about,
// whether its recorded owner can take a prompt, the admission checks, and the delivery itself
// with its journal. Ported from CH.Hub's scripts/lib/owner-session.mjs and the shared parts of
// scripts/wake-project.mjs, without the hub: projects come from Sterling's project registry, the
// owner record is the target checkout's own (owner-record.mjs), and the journal is the sender's
// (delivery-journal.mjs).
//
// Every dependency arrives in `deps` (realDeps in wake-project.mjs), so the tests run on fakes:
//   api(method, path)        GET reads, { code, stdout, stderr } (opencode-api.mjs createHttpApi)
//   send(method, path, body) the one POST, { ok, data, uncertain, why } (opencode-api.mjs apiSend)
//   realpath, readdir, gitWorktrees(root, ms), now()   as session-inventory.mjs needs them
//   processCwds()            [{ pid, cwd }] of this machine, for a removed folder's shells
//   readOwner(checkout), transitionOwner(checkout, cas)   owner-record.mjs
//   readMultiSession(root)   multi-session.mjs
//   runLock(key)             a machine-wide per-checkout run lock, returns a release function
//   journal()                the sender's deliveryJournal (delivery-journal.mjs)
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { registryPath, readRegistrySnapshotReadOnly } from '@sterling/store';
import { createHttpApi, apiSend } from './opencode-api.mjs';
import { readOwner, transitionOwner } from './owner-record.mjs';
import { readMultiSession } from './multi-session.mjs';
import { deliveryJournal, newMessageId } from './delivery-journal.mjs';
import { resolveProjectRoots } from './worktree-root.mjs';
import {
  Fail, activeIds, canonical, checkoutOf, checkSessionId, getJson, inputGuard, isConductorCandidate, isUnder, mapLimit,
  parentOf, parseGitWorktrees, projectContext, readProjectInventories, readSessionSnapshot, sessionCheckouts,
} from './session-inventory.mjs';

export { Fail };
const PARALLEL = 8;
const MAX_DEPTH = 20;
const SHELL_DONE = new Set(['exited', 'timeout', 'killed']);
// The longest a run waits for another run's delivery to the same checkout.
export const RUN_LOCK_WAIT_MS = 30_000;

/** A refusal: nothing was sent; `reason` is a stable word, `why` the sentence. */
export class Refused extends Error {
  constructor(reason, why) {
    super(`${reason}: ${why}`);
    this.reason = reason;
    this.why = why;
  }
}

// The --set-owner command a no_owner refusal names. Every dynamic word is quoted for a POSIX shell, because a checkout
// path can hold a space or a quote.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export const shellQuote = (word) => (SAFE_WORD.test(word) ? word : `'${String(word).replace(/'/g, `'\\''`)}'`);
export function setOwnerCommand({ project, session, checkout }) {
  return ['node', 'bin/wake-project.mjs', '--set-owner', '--project', shellQuote(project), '--session', shellQuote(session), ...(checkout ? ['--checkout', shellQuote(checkout)] : [])].join(' ');
}

// The session checkout that `key` nests with, if any: one that holds it or that it holds. A session is placed by the folder
// it runs in, so a checkout inside another one would take that one's sessions.
export function nestedCheckout(all, key) {
  return all.find((c) => c.key !== key && (isUnder(c.key, key) || isUnder(key, c.key)));
}

/**
 * Which checkout of the project a run is about. `path` is the --checkout value; without it the main checkout. The folder,
 * resolved, must be the project's main folder or one of its session worktrees (a direct child of <main>.worktrees/ that git
 * registers); anything else is exit 2. Returns { main, root, canonicalRoot, mainRoot, all }: `root` is the folder the
 * checkout's records live in, `canonicalRoot` its key, `mainRoot` the main checkout's key and `all` the session checkouts.
 */
export async function resolveCheckout(deps, ctx, path) {
  if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path))) throw new Fail(2, `--checkout needs the absolute path of a checkout, got ${JSON.stringify(path)}`);
  const all = await sessionCheckouts(deps, ctx.root, ctx.canonicalRoot);
  const main = { main: true, root: ctx.root, canonicalRoot: ctx.canonicalRoot, mainRoot: ctx.canonicalRoot, all };
  if (path === undefined) return main;
  const real = await canonical(deps.realpath, path, '--checkout');
  if (real === ctx.canonicalRoot) return main;
  const found = all.find((c) => c.key === real);
  if (!found) throw new Fail(2, `--checkout ${path} is not a checkout of ${basename(ctx.root)}: its checkouts are ${[ctx.canonicalRoot, ...all.map((c) => c.key)].join(', ')}`);
  const nested = nestedCheckout(all, found.key);
  if (nested) throw new Fail(2, `--checkout ${path} nests with the session worktree ${nested.key}, so the sessions of the two cannot be told apart`);
  return { main: false, root: found.raw, canonicalRoot: found.key, mainRoot: ctx.canonicalRoot, all };
}

const shapeOf = (scope) => ({ main: scope.mainRoot, sessions: scope.all.map((c) => c.key) });

/**
 * Whether session `id` can own the checkout `scope`: { ok: true, id, directory } or { ok: false, why } when it is gone (the
 * server's 404 only), a subagent, archived, not a conductor session (the maintenance worker among them) or running outside
 * the checkout. Any other failure throws.
 */
export async function usableOwner(deps, id, scope) {
  checkSessionId(id, 'owner session');
  const where = `GET /api/session/${id}`;
  let one;
  try {
    one = await getJson(deps.api, `/api/session/${id}`);
  } catch (e) {
    if (e instanceof Fail && e.httpStatus === 404) return { ok: false, why: `session ${id} no longer exists` };
    throw e;
  }
  const info = one?.data;
  if (info?.id !== id) throw new Fail(1, `${where}: reply is for ${JSON.stringify(info?.id)}`);
  if (parentOf(info, where) !== null) return { ok: false, why: `session ${id} is a subagent session` };
  if (info.time?.archived) return { ok: false, why: `session ${id} is archived` };
  if (!isConductorCandidate(info)) return { ok: false, why: `session ${id} is not a conductor session (agent ${info.agent})` };
  const directory = info.location?.directory;
  const real = await canonical(deps.realpath, directory, where);
  if (checkoutOf(real, shapeOf(scope)) !== scope.canonicalRoot) return { ok: false, why: `session ${id} runs in ${directory}, not in the checkout ${scope.canonicalRoot}` };
  return { ok: true, id, directory };
}

// Every session below `id` in the snapshot, at any depth, ended ones included (hazard fa5791e3: an ended child can still
// have a running shell).
export function descendantsOf(snapshot, id) {
  const children = new Map();
  for (const s of snapshot.values()) {
    const parent = parentOf(s, 'session snapshot');
    if (parent === null) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(s);
  }
  const out = [];
  let level = [id];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > MAX_DEPTH) throw new Fail(1, `session ${id}: its subagent tree is deeper than ${MAX_DEPTH}`);
    const next = level.flatMap((p) => children.get(p) ?? []);
    out.push(...next);
    level = next.map((s) => s.id);
  }
  return out;
}

// The top-level session an id belongs to, read from the snapshot and, for an id the snapshot lacks (it started after it),
// from the server. Throws when the chain cannot be followed.
async function rootOf(deps, snapshot, id) {
  const seen = new Set();
  let current = id;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (seen.has(current)) throw new Fail(1, `session ${id}: parent chain loops back to ${current}`);
    seen.add(current);
    const s = snapshot.get(current) ?? (await getJson(deps.api, `/api/session/${checkSessionId(current, 'parent chain')}`))?.data;
    if (s?.id !== current) throw new Fail(1, `session ${id}: cannot read ${current} in its parent chain`);
    const parent = parentOf(s, `session ${current}`);
    if (parent === null) return current;
    current = parent;
  }
  throw new Fail(1, `session ${id}: parent chain is deeper than ${MAX_DEPTH}`);
}

const tagOf = (text) => {
  try {
    return JSON.parse(text)?._tag;
  } catch {
    return undefined;
  }
};

// The running shells of the folders in `dirs` (GET /api/shell per folder; the list carries no session id). For a folder the
// server says no longer exists, the processes of this machine whose working directory is in it stand in. Returns
// { shells, unknown }: a folder that cannot be read is unknown, never taken for one without shells.
export async function runningShells(deps, dirs) {
  const reads = await mapLimit(dirs, PARALLEL, async (dir) => {
    const path = `/api/shell?location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
    const r = await deps.api('GET', path);
    if (r.code === 0) {
      let res;
      try {
        res = JSON.parse(r.stdout);
      } catch {
        return { unknown: `${dir}: the shell list is not JSON` };
      }
      if (!Array.isArray(res?.data)) return { unknown: `${dir}: the reply has no list of shells` };
      return { shells: res.data.filter((s) => !SHELL_DONE.has(s?.status)).map((s) => ({ id: typeof s?.id === 'string' ? s.id : 'unknown', dir })) };
    }
    const status = /^HTTP (\d{3})\b/.exec(String(r.stderr ?? '').trimStart())?.[1];
    if (status !== '404' || tagOf(r.stdout) !== 'LocationNotFoundError') return { unknown: `${dir}: the shell list cannot be read (${status ? `HTTP ${status}` : 'no usable answer'})` };
    if (typeof deps.processCwds !== 'function') return { unknown: `${dir} no longer exists and no process reader is available` };
    try {
      const inside = (await deps.processCwds()).filter(({ cwd }) => isUnder(cwd.replace(/ \(deleted\)$/, ''), dir));
      return { shells: inside.map(({ pid }) => ({ id: `pid ${pid}`, dir })) };
    } catch (e) {
      return { unknown: `${dir} no longer exists and the process scan failed: ${e.message}` };
    }
  });
  return { shells: reads.flatMap((r) => r.shells ?? []), unknown: reads.flatMap((r) => (r.unknown ? [r.unknown] : [])) };
}

const busyWord = (why) => why.some((w) => w === 'busy' || w.endsWith('is busy'));

/**
 * The admission of a prompt into `owner` (usableOwner's answer) of the checkout `scope`. Returns null to send, or a
 * Refused. All of these must hold, and a read that fails or is incomplete refuses (decision 1ca7b4e5, finding 0ded033d):
 *   - the project's inventory is complete, and the owner is not live: not running a turn, no subagent running at any depth,
 *     no question form or permission request open in its tree, no input queued (input_pending, busy);
 *   - for a wake, no OTHER conductor of the same checkout is live (ambiguous_session): one prompt goes to one conductor;
 *   - no running shell in the owner's folder or in the folder of any session of its tree (shell_running; the shell list
 *     names no session, so a running shell there cannot be attributed outside the owner's tree).
 * `final` repeats the target's own checks right before the POST and ends on the activity read.
 * NOT guaranteed: the moment between the last read and the POST (the server has no conditional prompt), and a reload of
 * the OpenCode service (hazard 7d1d2c71), which no route shows.
 */
export async function admission(deps, { registry, project, scope, owner, kind }) {
  const snapshot = await readSessionSnapshot(deps);
  const active = await activeIds(deps);
  const [inv] = await readProjectInventories(deps, registry, [{ project }], { snapshot, active });
  if (inv.unknown) return { refused: new Refused('unknown', `the sessions of ${project} cannot be read in full; nothing sent`) };
  const here = inv.live.filter((e) => e.checkout === scope.canonicalRoot);
  const mine = here.find((e) => e.id === owner.id);
  if (mine) {
    const why = mine.why.join(', ');
    return { refused: busyWord(mine.why) ? new Refused('busy', `owner session ${owner.id} is working (${why}); nothing sent`) : new Refused('input_pending', `owner session ${owner.id} is waiting on input (${why}); nothing sent`) };
  }
  const others = here.filter((e) => e.id !== owner.id);
  if (kind === 'wake' && others.length > 0) {
    return { refused: new Refused('ambiguous_session', `owner session ${owner.id} is idle but ${others.length} other conductor(s) of the checkout are live: ${others.map((e) => `${e.id} (${e.why.join(', ')})`).join('; ')}; nothing sent`) };
  }
  const tree = descendantsOf(snapshot, owner.id);
  return { refused: await shellsRefusal(deps, owner, tree), snapshot, tree };
}

async function shellsRefusal(deps, owner, tree) {
  const dirs = [...new Set([owner.directory, ...tree.map((s) => s.location?.directory).filter((d) => typeof d === 'string' && isAbsolute(d))])];
  const { shells, unknown } = await runningShells(deps, dirs);
  if (unknown.length > 0) return new Refused('unknown', `the running shells cannot be established (${unknown.join('; ')}); nothing sent`);
  if (shells.length > 0) return new Refused('shell_running', `a shell command still runs where owner session ${owner.id} or its subagents work (${shells.map((s) => `${s.id} in ${s.dir}`).join('; ')}); nothing sent`);
  return null;
}

/** The last checks before the POST: the target's own input, its shells, then the activity read. Null to send. */
export async function finalAdmission(deps, { owner, snapshot, tree }) {
  const pending = await inputGuard(deps.api, owner.directory, owner.id);
  if (pending) return new Refused('input_pending', `owner session ${owner.id}: ${pending}; nothing sent`);
  const shells = await shellsRefusal(deps, owner, tree);
  if (shells) return shells;
  const mineIds = new Set([owner.id, ...tree.map((s) => s.id)]);
  for (const id of await activeIds(deps)) {
    if (mineIds.has(id)) return new Refused('busy', `owner session ${owner.id} is working (${id === owner.id ? 'busy' : `its subagent ${id} is busy`}); nothing sent`);
    if (!snapshot.has(id) && (await rootOf(deps, snapshot, id)) === owner.id) return new Refused('busy', `owner session ${owner.id} is working (its new subagent ${id} is busy); nothing sent`);
  }
  return null;
}

/**
 * Whether a journal record's prompt reached its session: 'delivered' (its message id is in the session's inbox or message
 * list), 'gone' (the session no longer exists) or 'absent'. The inbox is read first: a queued prompt moves from the inbox
 * to the message list, never back.
 */
export async function receipt(deps, record) {
  const session = checkSessionId(record.session, 'journal record');
  try {
    const inbox = await getJson(deps.api, `/api/session/${session}/inbox`);
    if (!Array.isArray(inbox?.data)) throw new Fail(1, `GET /api/session/${session}/inbox: unexpected shape`);
    if (inbox.data.some((e) => e?.id === record.id)) return 'delivered';
  } catch (e) {
    if (e instanceof Fail && e.httpStatus === 404) return 'gone';
    throw e;
  }
  try {
    await getJson(deps.api, `/api/session/${session}/message/${record.id}`);
    return 'delivered';
  } catch (e) {
    if (!(e instanceof Fail && e.httpStatus === 404)) throw e;
  }
  return 'absent';
}

// A machine-wide lock per target checkout, held from the journal reconciliation to the recorded outcome, so two senders
// never admit and send into one owner at once. An abstract Unix socket (Linux only, as the toolkit): the kernel frees it
// when the holder ends, so it is never stale.
export function holdRunLock(key, waitMs = RUN_LOCK_WAIT_MS) {
  const name = `\0sterling-delivery:${process.getuid()}:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  const started = Date.now();
  const attempt = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(new Fail(1, `cannot take the delivery lock of ${key}: ${e.message}`))));
    server.listen({ path: name }, () => {
      server.unref();
      resolve(() => new Promise((done) => server.close(() => done())));
    });
  });
  return (async () => {
    for (;;) {
      const release = await attempt();
      if (release) return release;
      if (Date.now() - started >= waitMs) throw Object.assign(new Error(`another delivery to ${key} held its lock for ${Math.round(waitMs / 1000)} s`), { lockTimeout: true });
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
}

/** The sender's name for a prompt's text: its registry name, or its folder's name when it is not registered. */
export async function senderName(deps, registry) {
  if (!deps.senderRoot) return 'an unregistered folder';
  const real = await deps.realpath(deps.senderRoot);
  for (const r of registry) {
    try {
      if (typeof r?.repo_path === 'string' && (await deps.realpath(r.repo_path)) === real) return r.name;
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
    }
  }
  return basename(deps.senderRoot);
}

/**
 * One delivery of `text` (kind 'wake' or 'notify') to the owner of one checkout of `args.project`. Never throws: the answer
 * is { project, status, sent, ... } with status queued (sent yes), delivered (an earlier prompt of the same text was found
 * delivered; nothing new sent), would_queue (dry run), refused (reason, why; sent none) or failed (code, error; sent none
 * or maybe). `sent: 'maybe'` means the prompt may be in the session: never send it again without the journal's recovery.
 */
export async function deliver(kind, args, deps, registry, text) {
  const out = { project: args.project, sent: 'none' };
  try {
    const ctx = await projectContext(deps, registry, args.project);
    const scope = await resolveCheckout(deps, ctx, args.checkout);
    if (args.checkout !== undefined) out.checkout = scope.canonicalRoot;
    const settings = deps.readMultiSession(ctx.root);
    if (!settings.enabled && !args.dryRun) {
      throw new Refused('multi_session_off', `${args.project} has the multi-session toolkit off (multi_session.enabled is false), so it takes no ${kind}; it turns it on with config_set path "multi_session.enabled" value true`);
    }
    const recorded = deps.readOwner(scope.root);
    if (recorded === null) {
      throw new Refused('no_owner', `no owner session is recorded for ${scope.main ? args.project : `the checkout ${scope.canonicalRoot} of ${args.project}`}; the plugin records the session the user last prompted there, or run ${setOwnerCommand({ project: args.project, session: '<id>', checkout: scope.main ? undefined : scope.canonicalRoot })} from that project`);
    }
    out.session = recorded.session;
    const first = await usableOwner(deps, recorded.session, scope);
    if (!first.ok) throw new Refused('owner_missing', `${first.why}; nothing sent`);
    let release = null;
    if (!args.dryRun) {
      try {
        release = await deps.runLock(scope.canonicalRoot);
      } catch (e) {
        if (e?.lockTimeout) throw new Refused('lock_timeout', `${e.message}; nothing sent`);
        throw e;
      }
    }
    try {
      return await admitAndSend(kind, args, deps, registry, text, { out, scope, owner: first, recorded });
    } finally {
      if (release) await release();
    }
  } catch (e) {
    if (e instanceof Refused) return { ...out, status: 'refused', reason: e.reason, why: e.why };
    return { ...out, status: 'failed', code: e instanceof Fail ? e.code : 1, error: String(e?.message ?? e) };
  }
}

async function admitAndSend(kind, args, deps, registry, text, { out, scope, owner, recorded }) {
  const journal = args.dryRun ? null : deps.journal();
  const target = { project: args.project, checkout: scope.canonicalRoot };
  // Recovery first: a prompt this sender may have sent to this checkout is settled before anything new goes out.
  let resend = null;
  for (const p of journal ? journal.pending(target.project, target.checkout) : []) {
    const seen = await receipt(deps, p);
    const same = p.kind === kind && p.body === args.body;
    if (seen === 'delivered') {
      await journal.settle(p.id, 'delivered', 'found in the session after an uncertain send');
      if (same) return { ...out, status: 'delivered', sent: 'yes', id: p.id, session: p.session, reconciled: true };
    } else if (seen === 'gone' || p.session !== owner.id) {
      await journal.settle(p.id, 'abandoned', seen === 'gone' ? `session ${p.session} no longer exists` : `the owner changed to ${owner.id} before the prompt was found or resent`);
    } else if (same) {
      resend = p;
    } else {
      throw new Refused('unresolved_delivery', `an earlier ${p.kind} ${p.id} (${p.created_at}) to ${owner.id} may or may not have arrived and is not in the session; run that ${p.kind} again to resend it with the same id, then this one; nothing sent`);
    }
  }
  const admitted = await admission(deps, { registry, project: args.project, scope, owner, kind });
  if (admitted.refused) throw admitted.refused;
  const id = resend?.id ?? newMessageId(deps.now());
  const prompt = resend?.text ?? text;
  if (args.dryRun) return { ...out, status: 'would_queue', session: owner.id, text: prompt };
  // The owner record is the target runtime's: re-read, so a /new or a --set-owner during the admission sends nothing.
  const now = deps.readOwner(scope.root);
  if (now?.session !== recorded.session) throw new Refused('owner_changed', `the owner of the checkout changed from ${recorded.session} to ${now?.session ?? 'none'} during the admission; nothing sent`);
  const still = await usableOwner(deps, owner.id, scope);
  if (!still.ok) throw new Refused('owner_missing', `${still.why}; nothing sent`);
  const last = await finalAdmission(deps, { owner, snapshot: admitted.snapshot, tree: admitted.tree });
  if (last) throw last;
  await journal.sending({ id, kind, body: args.body, text: prompt, sender: deps.senderRoot ?? null, ...target, session: owner.id });
  out.sent = 'maybe';
  out.id = id;
  const r = await deps.send('POST', `/api/session/${owner.id}/prompt`, { id, text: prompt, delivery: 'queue' });
  if (r.ok && r.data?.data?.sessionID === owner.id && r.data.data.delivery === 'queue') {
    await journal.settle(id, 'delivered');
    return { ...out, status: 'queued', sent: 'yes', session: owner.id, ...(resend ? { resent: true } : {}) };
  }
  if (!r.ok && !r.uncertain) {
    await journal.settle(id, 'failed', r.why);
    return { ...out, status: 'failed', sent: 'none', code: 1, error: `POST /api/session/${owner.id}/prompt was not sent: ${r.why}` };
  }
  const why = r.ok ? `the reply shows delivery ${JSON.stringify(r.data?.data?.delivery)} for ${JSON.stringify(r.data?.data?.sessionID)}` : r.why;
  await journal.settle(id, 'uncertain', why);
  return { ...out, status: 'failed', code: 1, error: `the prompt ${id} to ${owner.id} may have been sent (${why}); run the same command again: it looks for the prompt and resends it with the same id only when it is absent` };
}

/** Real dependencies shared by both scripts. */
export function realDeps() {
  const senderRoot = resolveProjectRoots(process.cwd())?.storeRoot ?? null;
  return {
    api: createHttpApi(),
    send: (method, path, body) => apiSend(method, path, body),
    realpath: (p) => realpath(p),
    readdir: (dir) => readdir(dir),
    gitWorktrees: (root, ms) => new Promise((resolve, reject) => {
      execFile('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(new Fail(1, `git worktree list in ${root} failed: ${err.message}`)) : resolve(parseGitWorktrees(stdout))));
    }),
    processCwds: async () => {
      const found = [];
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          found.push({ pid: Number(name), cwd: await readlink(join('/proc', name, 'cwd')) });
        } catch (e) {
          if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e?.code)) throw e;
        }
      }
      return found;
    },
    now: () => Date.now(),
    listProjects: () => {
      const path = registryPath();
      if (!existsSync(path)) throw new Fail(1, `there is no project registry at ${path} (projects are registered by /sterling:init)`);
      // Read-only: a writable registry open would migrate the file and checkpoint its WAL (hazard 8616e72d).
      return readRegistrySnapshotReadOnly(path, 1_000).rows.map((r) => ({ name: r.name, repo_path: r.repo_path }));
    },
    readOwner,
    transitionOwner,
    readMultiSession,
    runLock: (key) => holdRunLock(key),
    senderRoot,
    cwd: process.cwd(),
    journal: () => {
      if (!senderRoot) throw new Fail(2, `run this from inside a Sterling project: the delivery journal lives in its .sterling/transient (cwd ${process.cwd()})`);
      return deliveryJournal(senderRoot);
    },
  };
}

