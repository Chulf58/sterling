// Shared read-only session inventory and input guards for the multi-session toolkit (decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). It reads the OpenCode server through
// `deps.api(method, path)`, which answers { code, stdout, stderr } (scripts/lib/opencode-api.mjs), and
// never writes. Dependency-light on purpose: no store, no registry reader. The project list is passed in
// as [{ name, repo_path }] (the registry's rows).
import { basename, dirname, join, isAbsolute, sep } from 'node:path';
import { isConductorCandidate, isNonInputNotice } from './session-policy.mjs';
export { isConductorCandidate, likelyReset } from './session-policy.mjs';

const MAX_PAGES = 100;
// Rows asked for per page of the whole-history snapshot (board aedcf153): on 2026-10-26 the history was about 5,500 sessions and
// 100 a page was 56 requests per scan. The server takes any limit (limit=10000 answered every session) and the V2 spec makes it a
// maximum, so a page may hold fewer rows; the listing is followed to its empty last page either way.
const SNAPSHOT_LIMIT = 1000;
const MAX_DEPTH = 20;
// Real ids look like ses_eb94b4556ffenXgYywBYU2e8gi; nothing else may reach a URL path.
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

export function checkSessionId(id, where) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Fail(1, `${where}: unexpected session id ${JSON.stringify(id)}`);
  return id;
}

export class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `opencode api` reports a failed request as its first stderr line, `HTTP <status> <reason>`. The
// status is attached as httpStatus, read from that line only, so callers decide on it and never on
// the message text, which holds the request path (and with it any session id).
const httpStatusOf = (stderr) => {
  const m = /^HTTP (\d{3})\b/.exec(String(stderr ?? '').trimStart());
  return m ? Number(m[1]) : null;
};

export async function getJson(api, path) {
  const r = await api('GET', path);
  if (r.code !== 0) throw Object.assign(new Fail(1, `GET ${path} failed: ${(r.stderr || r.stdout || '').trim()}`), { httpStatus: httpStatusOf(r.stderr) });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Fail(1, `GET ${path} returned output that is not JSON`);
  }
}

export const isUnder = (dir, root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

// The paths in `git worktree list --porcelain -z`: fields are NUL-separated, a record starts with its
// `worktree <path>` field, and -z leaves a path unquoted.
export const parseGitWorktrees = (text) => String(text).split('\0').filter((f) => f.startsWith('worktree ')).map((f) => f.slice('worktree '.length));

export async function canonical(resolve, dir, what) {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
    throw new Fail(1, `${what}: directory ${JSON.stringify(dir)} is not an absolute path`);
  }
  try {
    return await resolve(dir);
  } catch (e) {
    throw new Fail(1, `${what}: cannot resolve directory ${dir}: ${e.message}`);
  }
}

// undefined or null means top-level; anything else must be a valid session id.
export function parentOf(s, where) {
  if (s.parentID === undefined || s.parentID === null) return null;
  return checkSessionId(s.parentID, `${where}: parentID of ${s.id}`);
}

// The ids of the running sessions on the server.
export async function activeIds(deps) {
  const active = await getJson(deps.api, '/api/session/active');
  if (!active || typeof active.data !== 'object' || active.data === null || Array.isArray(active.data)) {
    throw new Fail(1, 'GET /api/session/active: unexpected shape');
  }
  const ids = Object.keys(active.data);
  for (const id of ids) checkSessionId(id, 'GET /api/session/active');
  return ids;
}

const INBOX_PARALLEL = 8;
export const STALE_SUBAGENT_NOTICE_MS = 6 * 60 * 60 * 1000;

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  // Wait for the other workers even after one fails, so a caller's next scan cannot
  // overlap them and exceed the concurrency limit.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return out;
}

async function pendingIds(api, path) {
  const res = await getJson(api, path);
  if (!Array.isArray(res?.data)) throw new Fail(1, `GET ${path}: unexpected shape (data is not a list)`);
  return new Set(res.data.map((f) => f?.sessionID));
}

// The sessions with an open question form or permission request in one folder (same reads as inputGuard).
export async function pendingInDir(api, dir) {
  const loc = `location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
  return { forms: await pendingIds(api, `/api/form?${loc}`), perms: await pendingIds(api, `/api/permission/request?${loc}`) };
}

export async function inboxPending(api, session, { now, allowCompleted = true } = {}) {
  const path = `/api/session/${checkSessionId(session, 'live session')}/inbox`;
  const res = await getJson(api, path);
  if (!Array.isArray(res?.data)) throw new Fail(1, `GET ${path}: unexpected shape (data is not a list)`);
  const pending = res.data.filter((e) => !isNonInputNotice(e));
  if (pending.length === 0) return false;
  // Match transport metadata, never notification text. The target's own inputGuard
  // intentionally has no exception. Unknown entries or update times stay live.
  const completed = (e) => e?.type === 'synthetic'
    && e.payload?.metadata?.source === 'subagent'
    && e.payload.metadata.state === 'completed'
    && typeof e.payload.metadata.childID === 'string'
    && SESSION_ID_RE.test(e.payload.metadata.childID);
  if (!allowCompleted || !Number.isFinite(now) || !pending.every(completed)) return true;
  // The snapshot predates this inbox read. Only current metadata can establish that
  // these notices are stale; a newly arrived completion must keep the session live.
  const info = (await getJson(api, `/api/session/${session}`))?.data;
  return info?.id !== session || parentOf(info, `session ${session}`) !== null
    || !Number.isFinite(info.time?.updated) || now - info.time.updated < STALE_SUBAGENT_NOTICE_MS;
}

// The exact-directory, top-level listing; the inventory instead reads every
// session in one paginated snapshot, including quiet children that may hold pending requests.
export async function topLevelSessionsAt(api, root, { conductorsOnly = true } = {}) {
  return (await sessionRowsAt(api, root)).filter((s) => !conductorsOnly || isConductorCandidate(s));
}

async function sessionRowsAt(api, root, { all = false } = {}) {
  const out = [];
  const cursors = new Set();
  const ids = new Set();
  let cursor = null;
  // Global history has no fixed page budget: valid history must reach its terminator.
  // Repeated cursors or sessions fail instead of looping or trusting an incomplete snapshot.
  for (let page = 0; all || page < MAX_PAGES; page++) {
    const q = new URLSearchParams(root === undefined ? (all ? { limit: String(SNAPSHOT_LIMIT) } : { parentID: 'null' }) : { directory: root });
    if (cursor) q.set('cursor', cursor);
    const path = `/api/session?${q}`;
    const res = await getJson(api, path);
    if (!Array.isArray(res?.data)) throw new Fail(1, `GET ${path}: unexpected shape`);
    if (res.data.length === 0) return out;
    for (const s of res.data) {
      checkSessionId(s?.id, `GET ${path}`);
      if (typeof s.time?.updated !== 'number') throw new Fail(1, `GET ${path}: session ${s.id} without time.updated`);
      const dir = s.location?.directory;
      if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
        throw new Fail(1, `GET ${path}: session ${s.id} has directory ${JSON.stringify(dir)}, not an absolute path`);
      }
      const parent = parentOf(s, `GET ${path}`);
      if (all) {
        if (ids.has(s.id)) throw new Fail(1, `session snapshot repeats ${s.id}; refusing an incomplete listing`);
        ids.add(s.id);
      }
      if ((root === undefined || dir === root) && (all || parent === null)) out.push(s);
    }
    // The V2 OpenAPI (SessionsResponse) requires the cursor object and gives next as a cursor string
    // or null; a page with sessions and a null or no next is the last page (a CH.Hub anti-pattern:
    // follow cursor.next until it is absent). A missing cursor object, or a next that is not a
    // non-empty string, is not trusted.
    const info = res.cursor;
    if (info === null || typeof info !== 'object' || Array.isArray(info)) {
      throw new Fail(1, `GET ${path}: page has sessions but no usable cursor.next (the cursor is ${JSON.stringify(info ?? null)}); refusing to guess the rest`);
    }
    cursor = info.next;
    if (cursor === null || cursor === undefined) return out;
    if (typeof cursor !== 'string' || cursor === '') {
      throw new Fail(1, `GET ${path}: page has sessions but no usable cursor.next (${JSON.stringify(cursor)}); refusing to guess the rest`);
    }
    if (all && cursors.has(cursor)) throw new Fail(1, 'session snapshot has a repeated cursor; refusing an incomplete listing');
    cursors.add(cursor);
  }
  throw new Fail(1, `more than ${MAX_PAGES} pages of sessions for ${root}; refusing to guess`);
}

// A pending question form, permission request or queued input in `session` blocks a
// prompt into it. Returns the reason, or null. `root` is the raw project root.
export async function inputGuard(api, root, session) {
  const list = async (path) => {
    const res = await getJson(api, path);
    if (!Array.isArray(res?.data)) throw new Fail(1, `GET ${path}: unexpected shape (data is not a list)`);
    return res.data;
  };
  const loc = `location%5Bdirectory%5D=${encodeURIComponent(root)}`;
  if ((await list(`/api/form?${loc}`)).some((f) => f?.sessionID === session)) return 'a question form is open';
  if ((await list(`/api/permission/request?${loc}`)).some((f) => f?.sessionID === session)) return 'a permission request is open';
  if ((await list(`/api/session/${session}/inbox`)).some((e) => !isNonInputNotice(e))) return 'input is already queued';
  return null;
}

// A folder's canonical path, or null when it is gone; any other resolve error stops the run.
async function resolvedOrNull(resolve, dir) {
  try {
    return await resolve(dir);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw new Fail(1, `cannot resolve directory ${dir}: ${e.message}`);
  }
}

// The longest one project's session worktree discovery (its folder reads, link resolution and git read)
// may take. A project whose discovery outlives it is unknown, and the pass over the others goes on.
export const DISCOVERY_TIMEOUT_MS = 10_000;

// Runs `read` and fails when it outlives `ms`. A stalled read cannot be cancelled, only given up on.
async function within(ms, what, read) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Fail(1, `${what} took longer than ${ms} ms`)), ms); });
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// One discovery's own time. It ends at `until` (a time on deps.now's clock) and for good once `close` is called. A stalled
// read cannot be cancelled, so the discovery that gave up on it may still be continued when that read returns: `left` is
// asked before every read and refuses once the discovery ended or its time is up, so a continuation starts nothing more
// (no folder read, no link resolution, no git). It answers the time the read about to start may take.
function discoveryClock(deps, budget) {
  const until = deps.now() + budget;
  let closed = false;
  return {
    close: () => { closed = true; },
    left: (what) => {
      if (closed) throw new Fail(1, `the discovery was given up on before ${what}`);
      const left = until - deps.now();
      if (left <= 0) throw new Fail(1, `out of time before ${what}`);
      return left;
    },
  };
}

// The project's session worktrees, its checkouts besides the main folder (one conductor per checkout): the direct children of
// <main folder>.worktrees/ (links included, resolved) that git registers as worktrees of the project.
// deps.readdir lists the folder (an absent one holds none) and deps.gitWorktrees(root, ms) answers the paths
// git registers; that is one git read for the project however many checkouts it has, and none while the
// folder is empty. Folders are compared as canonical paths, never by name. Git registering a folder is no
// proof of where it is: an accepted folder must never be in, on or around the main folder
// (isSessionCheckoutPath), whatever links lead there; a conductor in such a folder is the main
// checkout's, never a checkout of its own. A folder git does not register is not a checkout,
// and a registered worktree whose folder is gone is skipped. A folder or a git read that fails throws, so
// the project's inventory is unknown, never taken for a project without checkouts. Returns [{ key, raw }]:
// the canonical folder, which is the checkout's key, and the path it was listed under.
// The whole discovery runs inside discoveryBudget, as one absolute time (discoveryClock): every read asks what is
// left before it starts, git gets the time left rather than the budget it began with, and nothing starts once the
// discovery ended. The folders it names go to `evidence` first and stay there when a read fails, because they are
// this project's own.
export async function sessionCheckouts(deps, root, canonicalRoot, evidence = new Set()) {
  for (const folder of new Set([sessionWorktreesFolder(root), sessionWorktreesFolder(canonicalRoot)])) evidence.add(folder);
  const what = `reading the session worktree folders of ${root}`;
  const budget = discoveryBudget(deps, what);
  const clock = discoveryClock(deps, budget);
  try {
    return await within(budget, what, () => discoverCheckouts(deps, root, canonicalRoot, evidence, clock));
  } finally {
    clock.close();
  }
}

async function discoverCheckouts(deps, root, canonicalRoot, evidence, clock) {
  const folders = [...new Set([sessionWorktreesFolder(root), sessionWorktreesFolder(canonicalRoot)])];
  const children = [];
  for (const folder of folders) {
    if (!deps.readdir) throw new Fail(1, `cannot list the session worktree folders in ${folder}: no folder reader`);
    clock.left(`listing ${folder}`);
    let names;
    try {
      // Links count: a session worktree folder may be one, and it is judged by where it resolves.
      names = await deps.readdir(folder, { links: true });
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw new Fail(1, `cannot list the session worktree folders in ${folder}: ${e.message}`);
      names = [];
    }
    if (names.length === 0) continue;
    clock.left(`resolving ${folder}`);
    const real = await resolvedOrNull(deps.realpath, folder);
    if (real === null) continue;
    children.push(...names.map((name) => join(folder, name)));
    // A session may be stored under the resolved path of a linked container, which has no lexical tie to the link: its
    // children are named before any is resolved, so a failed read stays with this project, whose own folders they are.
    for (const name of names) evidence.add(join(real, name));
  }
  if (children.length === 0) return [];
  if (typeof deps.gitWorktrees !== 'function') throw new Fail(1, `cannot tell which folders in ${folders.join(' or ')} are git worktrees: no git reader`);
  const where = { main: canonicalRoot };
  const candidates = new Map();
  for (const raw of children) {
    clock.left(`resolving ${raw}`);
    const key = await resolvedOrNull(deps.realpath, raw);
    if (key !== null && isSessionCheckoutPath(key, where)) {
      evidence.add(key);
      if (!candidates.has(key)) candidates.set(key, raw);
    }
  }
  if (candidates.size === 0) return [];
  const listed = await deps.gitWorktrees(root, clock.left(`asking git for the worktrees of ${root}`));
  const registered = new Set([...candidates.keys()].filter((key) => listed.includes(key)));
  if (registered.size < candidates.size) {
    // Git writes canonical paths, but a registered path may still run through a link: compare canonical folders.
    for (const path of listed) {
      clock.left(`resolving ${path}`);
      const real = await resolvedOrNull(deps.realpath, path);
      if (real !== null) registered.add(real);
    }
  }
  return [...candidates].filter(([key]) => registered.has(key)).map(([key, raw]) => ({ key, raw }));
}

// A tick observes sources once, then derives every project from those same results. Discovery
// supplies the dependency map for one bounded input pass; no project performs its own reads.
// This does not promise freshness after the pass: later input is observed on the next tick.
export async function readSessionSnapshot(deps) {
  return new Map((await sessionRowsAt(deps.api, undefined, { all: true })).map((session) => [session.id, session]));
}

async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

function inventoryAncestor(sessions, id) {
  const seen = new Set();
  let current = id;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (seen.has(current)) throw new Fail(1, `session ${id}: parent chain loops back to ${current}`);
    seen.add(current);
    const session = sessions.get(current);
    if (!session) throw new Fail(1, `session ${id}: parent ${current} is absent from the snapshot`);
    const parent = parentOf(session, 'session snapshot');
    if (parent === null) return session;
    current = parent;
  }
  throw new Fail(1, `session ${id}: parent chain is deeper than ${MAX_DEPTH}`);
}

export async function readProjectInventories(rawDeps, registry, projects, observed = {}) {
  const resolutions = new Map();
  // Each folder is resolved once per pass and every consumer (a project's discovery, the later pass over the session
  // folders) shares that one answer. A stalled resolution cannot be cancelled, so the shared answer is bounded when it
  // is first asked for: it settles, as a failure, within the discovery bound and never past the run's deadline. A
  // consumer waiting on it fails with it (the projects of that folder are unknown) instead of waiting on a promise
  // that never settles.
  const deps = { ...rawDeps, realpath: async (dir) => {
    if (!resolutions.has(dir)) {
      const what = `resolving ${dir}`;
      resolutions.set(dir, within(discoveryBudget(rawDeps, what), what, () => rawDeps.realpath(dir)));
    }
    return resolutions.get(dir);
  } };
  const plans = await mapLimit(projects, INBOX_PARALLEL, async ({ project, owner, checkoutOwners = {} }) => {
    const projectDeps = { ...deps };
    const context = await observe(() => projectContext(projectDeps, registry, project));
    if (!context.ok && context.error instanceof Fail && context.error.code === 2) throw context.error;
    // The checkouts besides the main folder are read after the context: a failed or stalled read leaves this
    // project unknown, like an unreadable root, and nothing else. The folders the read names go to `evidence`
    // first and stay there when it fails: they are this project's own, so a session folder that cannot be
    // resolved later is attributed to this project and never to every project.
    const evidence = new Set();
    const discovered = context.ok
      ? await observe(() => sessionCheckouts(projectDeps, context.value.root, context.value.canonicalRoot, evidence))
      : context;
    const checkouts = discovered.ok ? discovered.value : [];
    // Where a folder belongs (checkoutOf, placeIn): the main folder is the main checkout, each registered session
    // worktree is its own.
    const shape = discovered.ok ? { main: context.value.canonicalRoot, sessions: checkouts.map((c) => c.key) } : undefined;
    return { project, owner, checkoutOwners: { ...checkoutOwners }, root: resolveProject(registry, project), deps: projectDeps, context, evidence, checkouts, shape, unknown: !discovered.ok, live: new Map(), tops: [] };
  });
  // Each live entry names its checkout (its key is the canonical folder); `main` is the key of the main one. `tops` is every
  // top-level conductor placed in a checkout of the project, { id, created, updated, checkout }, read from the same snapshot
  // (no call of its own); with the owner entry of a checkout it is what likelyReset judges. `checkoutOwners` is the recorded
  // owner session of each session checkout, kept only while it still runs in that checkout.
  const verdicts = () => plans.map(({ project, owner, checkoutOwners, unknown, live, shape, tops }) => unknown
    ? { project, owner, unknown: true } : { project, owner, checkoutOwners, live: [...live.values()], main: shape.main, tops });
  const markUnknown = (dependents) => { for (const plan of dependents) plan.unknown = true; };
  // `observed` is what the caller already read, its session snapshot and its running list. Each one given replaces this pass's own
  // read of it (finalAdmission hands over its first listing and the running list it read before it, so the history is not scanned
  // once more); nothing else about the pass changes.
  const reads = [observed.snapshot ? async () => observed.snapshot : () => readSessionSnapshot(deps), observed.active ? async () => observed.active : () => activeIds(deps)];
  const discovery = await mapLimit(reads, INBOX_PARALLEL, (read) => observe(read));
  if (discovery.some((source) => !source.ok)) {
    markUnknown(plans);
    return verdicts();
  }
  const sessions = discovery[0].value;
  const active = new Set(discovery[1].value);
  const eligible = (session) => parentOf(session, 'session snapshot') === null && isConductorCandidate(session);
  for (const plan of plans) if (sessions.has(plan.owner) && !eligible(sessions.get(plan.owner))) plan.owner = undefined;
  const ancestry = new Map(await mapLimit([...sessions.keys()], INBOX_PARALLEL, async (id) => [id, await observe(() => inventoryAncestor(sessions, id))]));
  const relevant = [...sessions.values()].filter((session) => !ancestry.get(session.id).ok || eligible(ancestry.get(session.id).value));
  const directories = [...new Set(relevant.map((session) => session.location.directory))];
  const locations = new Map(await mapLimit(directories, INBOX_PARALLEL, async (dir) => [dir, await observe(() => deps.realpath(dir))]));
  const missing = (location) => !location.ok && (location.error?.code === 'ENOENT' || location.error?.code === 'ENOTDIR');
  const usable = plans.filter((plan) => plan.shape !== undefined);
  // A recorded owner that runs outside the main checkout is no owner, as usableOwner holds: a session worktree is
  // another checkout. Kept, it would make a caller report the sole live conductor of
  // the main checkout as a duplicate of an owner that is not one. Only a folder that resolved is judged: a failure to
  // resolve already leaves its project unknown below.
  for (const plan of usable) {
    const location = locations.get(sessions.get(plan.owner)?.location.directory);
    if (location?.ok && !isUnder(location.value, plan.shape.main)) plan.owner = undefined;
    // The owner of a session checkout is judged the same way: one that is not a conductor, or runs outside its checkout, is none.
    for (const [folder, id] of Object.entries(plan.checkoutOwners)) {
      const info = sessions.get(id);
      const where = info && locations.get(info.location.directory);
      if (info && (!eligible(info) || (where?.ok && checkoutOf(where.value, plan.shape) !== folder))) delete plan.checkoutOwners[folder];
    }
  }
  const lexicalMatches = (dir) => plans.map((plan) => {
    const bases = [plan.root, plan.context.value?.canonicalRoot, sessionWorktreesFolder(plan.root), ...plan.evidence, ...plan.checkouts.flatMap((c) => [c.raw, c.key])];
    const length = Math.max(-1, ...bases.filter((base) => base !== undefined && isUnder(dir, base)).map((base) => base.length));
    return { plan, length };
  }).filter(({ length }) => length >= 0);
  // Only verified missing directories use single-project attribution. Other resolution
  // failures retain every matching alias or overlapping root, never a false absence.
  const lexicalOwner = (dir) => {
    const matches = lexicalMatches(dir);
    const longest = matches.reduce((owner, match) => !owner || match.length > owner.length ? match : owner, null);
    return longest ? [longest.plan] : [];
  };
  // Where a folder belongs for one project: its checkout (checkoutOf), or null when it is in none.
  const placeIn = (plan, dir) => {
    const checkout = checkoutOf(dir, plan.shape);
    return checkout === null ? null : { checkout };
  };
  const dependencies = (dir) => {
    const location = locations.get(dir);
    if (location.ok) return usable.filter((plan) => placeIn(plan, location.value) !== null);
    if (missing(location)) return lexicalOwner(dir);
    const lexical = lexicalMatches(dir).map(({ plan }) => plan);
    return lexical.length ? lexical : usable;
  };
  const roots = new Map();
  for (const session of sessions.values()) {
    if (!eligible(session)) continue;
    const dir = session.location.directory;
    const location = locations.get(dir);
    const dependents = dependencies(dir);
    // Where this conductor runs for each project it counts for, known once its folder resolved.
    const places = new Map(location.ok ? dependents.map((plan) => [plan, placeIn(plan, location.value)]) : []);
    roots.set(session.id, { session, dependents, removed: missing(location), places });
    if (!location.ok && !missing(location)) markUnknown(dependents);
    for (const [plan, place] of places) {
      if (Number.isFinite(session.time?.created)) plan.tops.push({ id: session.id, created: session.time.created, updated: session.time.updated, checkout: place.checkout });
    }
  }
  // Prior occurrences may still have queued input while their old alias is gone.
  // Include those roots in the shared inbox pass even when nothing is running;
  // only a successful empty read establishes absence. With no membership evidence,
  // active trees remain possible dependents of every project; idle history is ignored.
  const activeRoots = new Set([...active].map((id) => ancestry.get(id)?.value?.id));
  for (const root of roots.values()) {
    if (!root.removed || root.dependents.length) continue;
    const prior = plans.filter((plan) => deps.priorSessions?.[plan.project]?.[root.session.id]);
    if (prior.length) root.dependents = prior;
    else if (activeRoots.has(root.session.id)) root.dependents = plans;
  }
  const requestLocations = new Map();
  for (const session of relevant) {
    const ancestor = ancestry.get(session.id);
    const dir = session.location.directory;
    const location = locations.get(dir);
    // A child's own terminal outcome establishes historical completion. Its parent's
    // outcome, or mere absence from the active list, says nothing about pending requests.
    const unfinishedChild = session.parentID != null && !['succeeded', 'failed', 'interrupted'].includes(session.outcome);
    if (!ancestor.ok) {
      if (!missing(location)) markUnknown(dependencies(dir));
      else if (active.has(session.id) || unfinishedChild) markUnknown(lexicalOwner(dir).length ? lexicalOwner(dir) : usable);
      continue;
    }
    const root = roots.get(ancestor.value.id);
    if (!root?.dependents.length) continue;
    if (!location.ok) {
      // An empty inbox cannot establish that a previously observed form or permission
      // ended. Preserve every prior request-dependent project, including worktree aliases.
      const requestDependents = plans.filter((plan) => deps.priorSessions?.[plan.project]?.[session.id]?.requestPending === true);
      markUnknown(requestDependents);
      if (!missing(location) || active.has(session.id) || unfinishedChild || requestDependents.length) markUnknown(root.dependents);
    } else {
      const dependents = requestLocations.get(dir) ?? new Set();
      for (const plan of root.dependents) dependents.add(plan);
      requestLocations.set(dir, dependents);
    }
  }
  const jobs = [
    ...[...roots.values()].filter((root) => root.dependents.length).map((root) => ({ root, dependents: root.dependents, read: () => inboxPending(deps.api, root.session.id, { now: deps.now() }) })),
    ...[...requestLocations].flatMap(([dir, dependents]) => {
      const loc = `location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
      return [
        { dependents, why: 'a question form is open', read: () => pendingIds(deps.api, `/api/form?${loc}`) },
        { dependents, why: 'a permission request is open', read: () => pendingIds(deps.api, `/api/permission/request?${loc}`) },
      ];
    }),
  ];
  // Both kinds share these eight workers, including any post-inbox exception metadata read.
  const observations = await mapLimit(jobs, INBOX_PARALLEL, (job) => observe(job.read));
  const entry = (plan, session, place) => {
    if (!plan.live.has(session.id)) plan.live.set(session.id, { id: session.id, dir: session.location.directory, busy: false, why: [], checkout: place?.checkout });
    return plan.live.get(session.id);
  };
  const add = (root, why, busy = false) => {
    if (root.removed) { markUnknown(root.dependents); return; }
    for (const plan of root.dependents) {
      const e = entry(plan, root.session, root.places.get(plan));
      e.busy ||= busy;
      if (!e.why.includes(why)) e.why.push(why);
    }
  };
  for (const id of active) {
    if (!sessions.has(id)) { markUnknown(usable); continue; }
    const ancestor = ancestry.get(id);
    if (!ancestor.ok) continue; // Its location and dependency failure were handled during discovery.
    const root = roots.get(ancestor.value.id);
    if (root) add(root, id === root.session.id ? 'busy' : `its subagent ${id} is busy`, id === root.session.id);
  }
  observations.forEach((observation, index) => {
    const job = jobs[index];
    if (!observation.ok) { markUnknown(job.dependents); return; }
    if (job.root) {
      if (observation.value) add(job.root, 'input is already queued');
      return;
    }
    for (const id of observation.value) {
      const ancestor = ancestry.get(id);
      if (!ancestor?.ok) { markUnknown(job.dependents); continue; }
      const root = roots.get(ancestor.value.id);
      if (root) add(root, id === root.session.id ? job.why : `its subagent ${id}: ${job.why}`);
    }
  });
  return verdicts();
}

export async function readProjectInventory(deps, registry, project, owner, observed) {
  return (await readProjectInventories(deps, registry, [{ project, owner }], observed))[0];
}

// The registry's rows are [{ name, repo_path }]. A name that is not registered is exit 2 (the caller's mistake), a
// name registered more than once is exit 1 (ambiguous, never guessed).
export function resolveProject(registry, name) {
  if (!Array.isArray(registry)) throw new Fail(1, 'the project registry must be a list of { name, repo_path }; refusing to guess the project root');
  const roots = [...new Set(registry.filter((r) => r?.name === name && typeof r.repo_path === 'string').map((r) => r.repo_path.replace(/\/+$/, '')))];
  if (roots.length === 0) throw new Fail(2, `project '${name}' is not in the Sterling project registry`);
  if (roots.length > 1) throw new Fail(1, `project '${name}' is registered more than once (${roots.join(', ')}); ambiguous`);
  return roots[0];
}

export async function projectContext(deps, registry, project) {
  const root = resolveProject(registry, project);
  return { root, canonicalRoot: await canonical(deps.realpath, root, `project root of ${project}`) };
}

// A project's checkouts are its main folder and each Sterling session worktree: a direct child of
// <main folder>.worktrees/ (made by scripts/open-session.mjs) that git registers as a worktree of the project.
export const sessionWorktreesFolder = (root) => join(dirname(root), `${basename(root)}.worktrees`);

// The checkout a folder belongs to, as the key of that checkout (the main folder, or the folder of a session
// worktree), or null when it belongs to none. All folders are in canonical form: `main` is the project's folder and
// `sessions` the folders of its registered session worktrees. The main folder wins over a session worktree folder
// that overlaps it, whatever links lead there. Session worktrees may nest: the longest one that holds the folder
// wins, so the answer never depends on the order they are listed in.
export function checkoutOf(dir, { main, sessions = [] }) {
  if (isUnder(dir, main)) return main;
  return sessions.filter((s) => isUnder(dir, s)).reduce((best, s) => (best === null || s.length > best.length ? s : best), null);
}

// Whether a canonical folder can be a session worktree of a project: never in, on or around the main folder,
// whatever links lead there. Git registering a folder proves nothing about where it is.
export const isSessionCheckoutPath = (dir, { main }) => !isUnder(dir, main) && !isUnder(main, dir);

// The time one discovery may take: the bound (deps.discoveryTimeoutMs lets a test shorten it), cut to what is
// left of the run's deadline when the run has one. Nothing starts once the deadline has passed.
function discoveryBudget(deps, what) {
  const bound = deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  if (typeof deps.deadline !== 'number') return bound;
  const left = deps.deadline - deps.now();
  if (left <= 0) throw new Fail(1, `out of time before ${what}`);
  return Math.min(bound, left);
}
