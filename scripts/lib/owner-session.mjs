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
//   prepareSend(method, path, body)  the one POST made ready: { send, discard } (opencode-api.mjs prepareSend)
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
import { createHttpApi, prepareSend } from './opencode-api.mjs';
import { arg, hasFlag } from './cli-args.mjs';
import { readOwner, transitionOwner } from './owner-record.mjs';
import { ClaimProblem, readItemClaim, realClaimReader, recheckClaim, summarize as summarizeClaim } from './claim-route.mjs';
import { readMultiSession } from './multi-session.mjs';
import { deliveryJournal, newMessageId } from './delivery-journal.mjs';
import { resolveProjectRoots } from './worktree-root.mjs';
import {
  Fail, activeIds, canonical, checkoutOf, checkSessionId, getJson, inboxPending, isConductorCandidate, isUnder, mapLimit,
  parentOf, parseGitWorktrees, pendingInDir, projectContext, readProjectInventories, readSessionSnapshot, sessionCheckouts,
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

/**
 * The shared flag reader of wake-project and notify-project, on the one exact-token parser (cli-args.mjs): `--flag value` and
 * `--flag=value` both work, a flag given twice or a value that looks like another flag is exit 2, and any other token is an
 * unknown argument. `values` are the flags that take a value, `bools` the ones that do not. Returns { name: value } for the
 * values given and { name: true } for the booleans given, keyed without the dashes.
 */
export function parseFlags(argv, { values, bools, usage }) {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
    if (bools.includes(t)) continue;
    if (!values.includes(name)) throw new Fail(2, `unknown argument '${t}'\n${usage}`);
    if (t === name) {
      const next = argv[++i];
      if (next === undefined) throw new Fail(2, `${name} needs a value`);
    }
  }
  const out = {};
  try {
    for (const v of values) {
      const got = arg(v, argv);
      if (got === '') throw new Fail(2, `${v} needs a value`);
      if (got !== undefined) out[v.slice(2)] = got;
    }
    for (const b of bools) if (hasFlag(b, argv)) out[b.slice(2)] = true;
  } catch (e) {
    throw e instanceof Fail ? e : new Fail(2, e.message);
  }
  return out;
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

// The top-level session (its info) an id belongs to, read from the snapshot and, for an id the snapshot lacks (it started after it),
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
    if (parent === null) return s;
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
 * One admission pass for a prompt into `owner` (usableOwner's answer) of the checkout `scope`. Returns null to send, or a
 * Refused. Every read is fresh, and a read that fails or is incomplete throws or refuses (decision 1ca7b4e5, finding
 * 0ded033d). In this order:
 *   b. one session snapshot. The owner's folder is taken from it, so an owner that moved inside its checkout is checked
 *      where it now runs. The project's inventory from that snapshot and one activity read must be complete (unknown).
 *      The owner must not be live: running a turn, a busy subagent, a form, permission request or queued input in it
 *      (busy, input_pending). For a wake no OTHER conductor of the same checkout may be live (ambiguous_session): one
 *      prompt goes to one conductor. A notify goes to the owner whatever the others do.
 *   c. every running id is resolved (cached): in the owner's tree, a new subagent of the owner (busy), a conductor of the
 *      checkout or one of its subagents (ambiguous_session, wake only), or neither. A session the snapshot lacks is placed
 *      by reading its parent chain; one that cannot be placed fails the run.
 *   d. ONE final evidence batch, after every lookup: the pending input, forms and permission requests of the owner's whole
 *      tree (every depth, ended subagents included, hazard fa5791e3), then running shells in every folder the tree uses
 *      (the shell list names no session, so a shell there cannot be attributed outside the tree), then the closing
 *      activity read, judged from the cached answers alone.
 *   e. a closing read holding an id not yet resolved goes back to c, and the whole batch d runs again; after
 *      MAX_ACTIVITY_ROUNDS rounds the run refuses (deferred), so it never sends on an unresolved read.
 * Null therefore means: nothing after the closing read's response was awaited here. deliver() then re-reads the owner
 * record synchronously and starts the already prepared POST at once.
 * The ONE window left is server-side: between the closing read and the server receiving the POST, a turn, a form or
 * input can still start. The server offers no conditional prompt, so no client can close it; it is accepted. A reload of
 * the OpenCode service (hazard 7d1d2c71) is not shown by any route either.
 */
export const MAX_ACTIVITY_ROUNDS = 3;
export async function admissionPass(deps, { registry, project, scope, owner: given, kind }) {
  const snapshot = await readSessionSnapshot(deps);
  const fresh = snapshot.get(given.id);
  if (!fresh) return new Refused('owner_missing', `session ${given.id} is not in the session listing; nothing sent`);
  const real = await canonical(deps.realpath, fresh.location?.directory, `session ${given.id}`);
  if (checkoutOf(real, shapeOf(scope)) !== scope.canonicalRoot) return new Refused('owner_missing', `session ${given.id} now runs in ${fresh.location?.directory}, not in the checkout ${scope.canonicalRoot}; nothing sent`);
  const owner = { ...given, directory: fresh.location.directory };
  const active = await activeIds(deps);
  const [inv] = await readProjectInventories(deps, registry, [{ project }], { snapshot, active });
  if (inv.unknown) return new Refused('unknown', `the sessions of ${project} cannot be read in full; nothing sent`);
  const here = inv.live.filter((e) => e.checkout === scope.canonicalRoot);
  const mine = here.find((e) => e.id === owner.id);
  // A notify queues behind a turn that is running (user ruling 2026-10-28, board c3ef9ea3: 'Queue it, like CH.Hub'): the
  // prompt lands when the turn ends. Only the busy words are dropped for it; any other reason still refuses.
  const blocking = kind === 'wake' ? mine?.why : mine?.why.filter((w) => !busyWord([w]));
  if (mine && blocking.length > 0) {
    const why = mine.why.join(', ');
    return busyWord(blocking) ? new Refused('busy', `owner session ${owner.id} is working (${why}); nothing sent`) : new Refused('input_pending', `owner session ${owner.id} is waiting on input (${why}); nothing sent`);
  }
  const others = here.filter((e) => e.id !== owner.id);
  if (kind === 'wake' && others.length > 0) return competing(owner, others);
  const tree = descendantsOf(snapshot, owner.id);
  const running = runningJudge(deps, { snapshot, scope, owner, tree, kind });
  let ids = active;
  for (let round = 1; round <= MAX_ACTIVITY_ROUNDS; round++) {
    await running.resolve(ids); // c
    const busy = running.judge(ids);
    if (busy) return busy;
    // d: the final evidence batch, after every lookup.
    const pending = await treePending(deps, owner, tree);
    if (pending) return pending;
    const shells = await shellsRefusal(deps, owner, tree);
    if (shells) return shells;
    const closing = await activeIds(deps);
    // From the closing response to the caller's POST: no read, no wait.
    if (running.knows(closing)) return running.judge(closing);
    ids = closing; // e
  }
  return new Refused('deferred', `new sessions kept appearing in the closing activity read (${MAX_ACTIVITY_ROUNDS} rounds); nothing sent`);
}

const competing = (owner, others) => new Refused('ambiguous_session', `owner session ${owner.id} is idle but ${others.length} other conductor(s) of the checkout are live: ${others.map((e) => `${e.id} (${e.why.join(', ')})`).join('; ')}; nothing sent`);

// What each running session means for the delivery (step c of admissionPass): resolve(ids) looks up what is not known
// yet; judge(ids) answers from the cache alone, with no read; knows(ids) says whether judge can answer.
function runningJudge(deps, { snapshot, scope, owner, tree, kind }) {
  const mineIds = new Set([owner.id, ...tree.map((s) => s.id)]);
  // id -> null (irrelevant), or the Refused its running means.
  const known = new Map();
  const one = async (id) => {
    // A running turn of the owner or its tree stops a wake only; a notify queues behind it (see admissionPass).
    if (mineIds.has(id)) return kind === 'wake' ? new Refused('busy', `owner session ${owner.id} is working (${id === owner.id ? 'busy' : `its subagent ${id} is busy`}); nothing sent`) : null;
    const root = await rootOf(deps, snapshot, id);
    if (root.id === owner.id) return kind === 'wake' ? new Refused('busy', `owner session ${owner.id} is working (its new subagent ${id} is busy); nothing sent`) : null;
    if (kind !== 'wake' || !isConductorCandidate(root)) return null;
    const real = await canonical(deps.realpath, root.location?.directory, `session ${root.id}`);
    return checkoutOf(real, shapeOf(scope)) === scope.canonicalRoot ? competing(owner, [{ id: root.id, why: [root.id === id ? 'busy' : `its subagent ${id} is busy`] }]) : null;
  };
  return {
    resolve: async (ids) => {
      for (const id of ids) if (!known.has(id)) known.set(id, await one(id));
    },
    knows: (ids) => ids.every((id) => known.has(id)),
    judge: (ids) => ids.map((id) => known.get(id)).find((r) => r) ?? null,
  };
}

// Queued input, an open form or a permission request anywhere in the owner's tree, its subagents included.
async function treePending(deps, owner, tree) {
  const members = new Set([owner.id, ...tree.map((s) => s.id)]);
  const queued = await mapLimit([...members], PARALLEL, async (id) => [id, await inboxPending(deps.api, id, { allowCompleted: false })]);
  const hit = queued.find(([, q]) => q);
  if (hit) return new Refused('input_pending', `owner session ${owner.id} is waiting on input (${hit[0] === owner.id ? '' : `its subagent ${hit[0]}: `}input is already queued); nothing sent`);
  const dirs = [...new Set([owner.directory, ...tree.map((s) => s.location?.directory).filter((d) => typeof d === 'string' && isAbsolute(d))])];
  for (const { forms, perms } of await mapLimit(dirs, PARALLEL, (dir) => pendingInDir(deps.api, dir))) {
    for (const [ids, what] of [[forms, 'a question form is open'], [perms, 'a permission request is open']]) {
      const id = [...ids].find((x) => members.has(x));
      if (id) return new Refused('input_pending', `owner session ${owner.id} is waiting on input (${id === owner.id ? '' : `its subagent ${id}: `}${what}); nothing sent`);
    }
  }
  return null;
}

async function shellsRefusal(deps, owner, tree) {
  const dirs = [...new Set([owner.directory, ...tree.map((s) => s.location?.directory).filter((d) => typeof d === 'string' && isAbsolute(d))])];
  const { shells, unknown } = await runningShells(deps, dirs);
  if (unknown.length > 0) return new Refused('unknown', `the running shells cannot be established (${unknown.join('; ')}); nothing sent`);
  if (shells.length > 0) return new Refused('shell_running', `a shell command still runs where owner session ${owner.id} or its subagents work (${shells.map((s) => `${s.id} in ${s.dir}`).join('; ')}); nothing sent`);
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
    let scope = await resolveCheckout(deps, ctx, args.checkout);
    if (args.checkout !== undefined) out.checkout = scope.canonicalRoot;
    const settings = deps.readMultiSession(ctx.root);
    if (!settings.enabled && !args.dryRun) {
      throw new Refused('multi_session_off', `${args.project} has the multi-session toolkit off (multi_session.enabled is false), so it takes no ${kind}; it turns it on with config_set path "multi_session.enabled" value true`);
    }
    // --item: the claim on the board item decides the destination (claim-route.mjs). A held claim makes its holder the
    // recipient, in the holder's checkout, and the owner record is not consulted; no claim or an expired one leaves the
    // owner as the recipient. Either way the claim is read again right before the send (admitAndSend).
    let route = null;
    if (args.item !== undefined) {
      if (args.checkout !== undefined) throw new Fail(2, '--item names its checkout itself (the holder\'s), so it does not combine with --checkout');
      const before = readItemClaim(deps, ctx.root, args.project, args.item);
      out.item = args.item;
      out.claim = summarizeClaim(args.item, before);
      route = { item: args.item, before, root: ctx.root, holder: before.state === 'held' };
    }
    let recorded = null;
    let first;
    if (route?.holder) {
      const claim = route.before;
      try {
        scope = await resolveCheckout(deps, ctx, claim.checkout);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        throw new Refused('holder_missing', `the claim on item ${args.item} is held by session ${claim.holder_session} from ${claim.checkout}, which is not a usable checkout of ${args.project} (${e.message}); not sending it to anyone else, nothing sent`);
      }
      out.checkout = scope.canonicalRoot;
      out.session = claim.holder_session;
      first = await usableOwner(deps, claim.holder_session, scope);
      if (!first.ok) throw new Refused('holder_missing', holderGone(args.item, claim.holder_session, first.why));
    } else {
      recorded = deps.readOwner(scope.root);
      if (recorded === null) {
        throw new Refused('no_owner', `no owner session is recorded for ${scope.main ? args.project : `the checkout ${scope.canonicalRoot} of ${args.project}`}; the plugin records the session the user last prompted there, or run ${setOwnerCommand({ project: args.project, session: '<id>', checkout: scope.main ? undefined : scope.canonicalRoot })} from that project`);
      }
      out.session = recorded.session;
      first = await usableOwner(deps, recorded.session, scope);
      if (!first.ok) throw new Refused('owner_missing', `${first.why}; nothing sent`);
    }
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
      return await admitAndSend(kind, args, deps, registry, text, { out, scope, owner: first, recorded, route });
    } finally {
      if (release) await release();
    }
  } catch (raw) {
    const e = asRefused(raw);
    // On a holder route the refusals speak of the holder: input waiting is the holder's own word for it, and a recipient that
    // is gone at ANY point (the first checks or the final admission) is holder_missing, never owner_missing.
    if (e instanceof Refused) {
      const holder = out.claim?.state === 'held';
      if (holder && e.reason === 'owner_missing') return { ...out, status: 'refused', reason: 'holder_missing', why: holderGone(args.item, out.session, e.why) };
      return { ...out, status: 'refused', reason: holder && e.reason === 'input_pending' ? 'holder_busy_form' : e.reason, why: e.why };
    }
    return { ...out, status: 'failed', code: e instanceof Fail ? e.code : 1, error: String(e?.message ?? e) };
  }
}

// A held claim whose holder cannot take the message, as a sentence: `why` is the owner-style reason ("session X ...; nothing sent").
const holderGone = (item, session, why) => `the claim on item ${item} is held by session ${session}, but ${why.replace(/^session \S+ /, 'it ').replace(/; nothing sent$/, '')}; not sending it to anyone else, nothing sent`;

// A claim problem leaves as the refusal of the same word.
const asRefused = (e) => (e instanceof ClaimProblem ? new Refused(e.reason, e.why) : e);

async function admitAndSend(kind, args, deps, registry, text, { out, scope, owner, recorded, route }) {
  const journal = args.dryRun ? null : deps.journal();
  const target = { project: args.project, checkout: scope.canonicalRoot };
  // The resolved item a message is about is part of its identity: a notice for item A is not a retry of the same text for item
  // B, even in one checkout, so recovery never settles B's notice with A's receipt. On an item route the recipient is part of
  // it too. A retry of the SAME notice (same item, same recipient) still finds its own record.
  const item = route?.before.id ?? null;
  // Recovery first: a prompt this sender may have sent to this checkout is settled before anything new goes out.
  let resend = null;
  for (const p of journal ? journal.pending(target.project, target.checkout) : []) {
    const seen = await receipt(deps, p);
    const same = p.kind === kind && p.body === args.body && (p.item ?? null) === item && (!route || p.session === owner.id);
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
  const first = await admissionPass(deps, { registry, project: args.project, scope, owner, kind });
  if (first) throw first;
  const id = resend?.id ?? newMessageId(deps.now());
  const prompt = resend?.text ?? text;
  if (args.dryRun) return { ...out, status: 'would_queue', session: owner.id, text: prompt };
  // The intent is journaled BEFORE the last checks: the journal write can wait on its lock, and nothing may wait between
  // the last check and the POST. A crash from here on leaves `sending`, which the next run settles by receipt or resends
  // under the same id. A refusal below is certainly unsent: a new record is settled failed, a resend goes back to
  // uncertain (its earlier attempt is still unaccounted for).
  await journal.sending({ id, kind, body: args.body, item, text: prompt, sender: deps.senderRoot ?? null, ...target, session: owner.id });
  let post = null;
  try {
    // The transport is made ready before the last checks, so its preparation (temp files, arguments) is not a wait
    // between them and the POST.
    post = await deps.prepareSend('POST', `/api/session/${owner.id}/prompt`, { id, text: prompt, delivery: 'queue' });
    const still = await usableOwner(deps, owner.id, scope);
    if (!still.ok) throw new Refused('owner_missing', `${still.why}; nothing sent`);
    const last = await admissionPass(deps, { registry, project: args.project, scope, owner: still, kind });
    if (last) throw last;
    // Two synchronous re-reads follow the closing activity read, then the POST; nothing is awaited between them. The claim
    // (--item, owner route and holder route alike) comes FIRST: its read is a database read that can block, so the owner
    // record, which is the target runtime's and changes with a /new or a --set-owner, is checked after it, last before the send.
    if (route) recheckClaim(deps, route.root, args.project, route.item, route.before);
    if (recorded) {
      const now = deps.readOwner(scope.root);
      if (now?.session !== recorded.session) throw new Refused('owner_changed', `the owner of the checkout changed from ${recorded.session} to ${now?.session ?? 'none'} during the admission; nothing sent`);
    }
  } catch (raw) {
    const e = asRefused(raw);
    const why = `not sent: ${e instanceof Refused ? `${e.reason}: ${e.why}` : String(e?.message ?? e)}`;
    await post?.discard();
    await journal.settle(id, resend ? 'uncertain' : 'failed', resend ? `${resend.why ?? 'an earlier attempt may have been sent'}; a resend was refused (${why})` : why);
    throw e;
  }
  out.sent = 'maybe';
  out.id = id;
  const r = await post.send();
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
    prepareSend: (method, path, body) => prepareSend(method, path, body),
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
    readClaim: (req) => realClaimReader(req),
    runLock: (key) => holdRunLock(key),
    senderRoot,
    cwd: process.cwd(),
    journal: () => {
      if (!senderRoot) throw new Fail(2, `run this from inside a Sterling project: the delivery journal lives in its .sterling/transient (cwd ${process.cwd()})`);
      return deliveryJournal(senderRoot);
    },
  };
}
