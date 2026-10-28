// /sterling:session --window: open an OpenCode conductor window for a session worktree of a Sterling project, in a tmux
// session of its own (slice 6 of the multi-session toolkit, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session; ported from CH.Hub's scripts/open-session-window.mjs, PR #128).
//
//   node scripts/open-session-window.mjs [--target <project-name|path>] (--name <label> | --checkout <folder>)
//        [--session <ses_id>] [--detached] [--attach-timeout <seconds, default 30>] [--dry-run]
//
// The checkout is a session worktree that scripts/open-session.mjs made: a direct child of <main>.worktrees/ that git
// registers as a worktree of the project (sessionCheckouts, scripts/lib/session-inventory.mjs). The main checkout's
// window is its own sterling-launch.sh's. Linux (WSL included) with tmux only; anything else is refused loudly. The
// project must have multi_session.enabled (exit 2 otherwise).
//
// THE SESSION STARTS IN THE WORKTREE AND IS NEVER MOVED (anti-patterns 63e3b8c3, 6da779c8): new-session -c <checkout>
// starts OpenCode there, and the checkout must hold .opencode/agents/sterling/conductor.md, or OpenCode would not find
// the conductor agent (`agents_missing`). The tmux session is named as the checkout's own generated launcher names it
// (scripts/lib/launchers.mjs sessionName plus -opencode), so that launcher reattaches to this window instead of
// starting a second one.
//
// THE CEILING. multi_session.max_sessions counts the occupied checkouts of the project: one with an OpenCode tmux
// window, a live conductor (the OpenCode API inventory), or a launch reservation. Count, compare and reservation run
// in one locked section (scripts/lib/launch-admission.mjs), and every piece of evidence is read inside it under one
// deadline (IN_LOCK_READ_MS: the API inventory, every tmux read, every path resolution; past it `admission_timeout`):
// the default tmux server, the one this launch uses, and every socket in the project's socket registry or named by a
// reservation. A registered socket is never taken for empty while its recorded server runs: unreadable, missing or
// answered by another server, it refuses (`tmux_unreadable`, naming it) until the server ends or --forget-socket drops
// it. So parallel launches can never pass the ceiling together, and a session that started while this launcher waited
// for the lock is counted. A started window stays counted until it is seen gone on its own server; an uncertain start
// until it expires, or, once its window is seen, as a started record of that window. Hand-opened sessions are
// counted, never blocked: only this launcher refuses (`ceiling_reached`).
//
// --forget-socket <path> (with --target only) drops one socket from the registry with every reservation naming it,
// under the lock, and prints what it forgot. It is cleanup, so it runs with multi_session off too.
//
// ADMISSION, read-only through the OpenCode API, inside the same locked section (a dry run included): a live conductor
// of this checkout refuses (`conductor_live`), an incomplete inventory refuses (`conductor_unknown`). With --session the
// session must exist, be a top-level conductor and run in this checkout (`session_not_found`, `session_not_conductor`,
// `session_other_checkout`); it may itself be live, being the conductor whose window this is.
//
// THE SERVER IS NAMED AND THE SESSION FOLLOWED BY ITS ID. Every tmux call names its server with -S: the one a plain tmux
// here reaches (TMUX inside tmux, else the default socket). new-session prints #{session_id}, #{pid} and #{start_time};
// every later look names the session by its id, and every later mutation (mouse on, both attach paths) runs behind a
// server-side if-shell guard on the server's pid AND start time, because a restarted server at the same socket can
// reuse the id and the pid (anti-pattern 8e603e23).
//
// THIS SCRIPT NEVER KILLS A SESSION: a client can attach to one between any look at it and a kill. A session for the
// same folder that appears around the creation is `window_conflict`: both are left running and named. A failed creation
// client can still have started OpenCode: `start_uncertain` keeps any partial output and asks for inspection before any
// retry. Only definite tmux rejections without creation output (duplicate name, bad arguments) are ordinary failures.
//
// Exit 0: started or would_start; 1: refused or failed; 2: bad arguments, multi_session off, unregistered project.
// One JSON line on stdout.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fail, canonical, checkoutOf, getJson, isConductorCandidate, readProjectInventory, sessionCheckouts } from './lib/session-inventory.mjs';
import { nestedCheckout, realDeps } from './lib/owner-session.mjs';
import { readMultiSession, multiSessionRefusal } from './lib/multi-session.mjs';
import { defaultOpencodeBin } from './lib/opencode-api.mjs';
import { OBSERVE_MS, admitLaunch, forgetSocket, settleLaunch } from './lib/launch-admission.mjs';
import { TMUX_ID_RE, defaultSocket, environmentSocket, guardedCommand, listSessions, readServer, isOpencodeCommand, sameServer, shq } from './lib/windows.mjs';
import { arg, hasFlag } from './lib/cli-args.mjs';
import { sessionName } from './lib/launchers.mjs';
import { resolveMainCheckout, resolveTarget, worktreePathFor } from './open-session.mjs';

const DEFAULT_ATTACH_TIMEOUT_S = 30;
// What the reads before the window may take, beyond the wait for the terminal.
const RUN_SLACK_MS = 90_000;
const POLL_MS = 1000;
// The one deadline of the whole locked observation (API inventory, tmux reads, path resolution); past it the launch is
// refused, the lock released and nothing admitted.
export const IN_LOCK_READ_MS = OBSERVE_MS;
const DIGITS_RE = /^[1-9]\d*$/;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// The binary's path goes into a tmux command and into the pane's start command, which the pane check reads: only a plain path.
const PLAIN_PATH_RE = /^\/[A-Za-z0-9._/@+-]+$/;
const AGENT_REL = join('.opencode', 'agents', 'sterling', 'conductor.md');
export const TERMINALS = ['ghostty', 'gnome-terminal', 'kitty', 'konsole', 'x-terminal-emulator'];
const USAGE = 'usage: open-session-window.mjs [--target <project-name|path>] (--name <label> | --checkout <session worktree folder>) [--session <ses_id>] [--detached] [--attach-timeout <seconds>] [--dry-run]\n       open-session-window.mjs [--target <project-name|path>] --forget-socket <socket path>';

// A refusal; `detail` is added to the JSON line, `exit` is the exit code.
class Stop extends Error {
  constructor(reason, why, detail = {}, exit = 1) {
    super(`${reason}: ${why}`);
    this.reason = reason;
    this.why = why;
    this.detail = detail;
    this.exit = exit;
  }
}

// A failure after the tmux session was created: the session exists and is left as it is.
class Started extends Error {
  constructor(window, id, message, socket = null, server = null) {
    super(message);
    this.window = window;
    this.id = id;
    this.socket = socket;
    this.server = server;
  }
}

const VALUE_FLAGS = ['--target', '--name', '--checkout', '--session', '--attach-timeout', '--forget-socket'];
const BOOL_FLAGS = ['--dry-run', '--detached'];

// The shared exact-token parser (scripts/lib/cli-args.mjs, decision
// sanctioned-script-store-writes-one-containment-helper-one-arg-parser): `--flag value` and `--flag=value` both work, a
// repeated flag is refused, never last-wins.
export function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const flag = tok.split('=')[0];
    if (BOOL_FLAGS.includes(flag)) {
      if (tok.includes('=')) throw new Fail(2, `${flag} takes no value`);
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) throw new Fail(2, `unknown argument '${tok}'\n${USAGE}`);
    if (!tok.includes('=')) i++;
  }
  const v = {};
  const args = { attachTimeout: DEFAULT_ATTACH_TIMEOUT_S };
  try {
    for (const f of VALUE_FLAGS) {
      v[f] = arg(f, argv);
      if (v[f] === '' || (v[f] === undefined && hasFlag(f, argv))) throw new Error(`${f} needs a value`);
    }
    args.dryRun = hasFlag('--dry-run', argv);
    args.detached = hasFlag('--detached', argv);
  } catch (e) {
    throw new Fail(2, e.message);
  }
  args.target = v['--target'];
  if (v['--name'] !== undefined) {
    if (!LABEL_RE.test(v['--name'])) throw new Fail(2, `--name '${v['--name']}' is not a session label (letters, digits, '-' and '_', starting with a letter or digit)`);
    args.name = v['--name'];
  }
  if (v['--checkout'] !== undefined) {
    if (!isAbsolute(v['--checkout'])) throw new Fail(2, `--checkout must be an absolute folder, got ${JSON.stringify(v['--checkout'])}`);
    args.checkout = v['--checkout'];
  }
  if (v['--session'] !== undefined) {
    if (!SESSION_ID_RE.test(v['--session'])) throw new Fail(2, `--session must be an OpenCode session id (ses_ and letters or digits), got ${JSON.stringify(v['--session'])}`);
    args.session = v['--session'];
  }
  if (v['--attach-timeout'] !== undefined) {
    const t = v['--attach-timeout'];
    if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 600) throw new Fail(2, `--attach-timeout must be whole seconds from 1 to 600, got '${t}'`);
    args.attachTimeout = Number(t);
  }
  if (v['--forget-socket'] !== undefined) {
    if (!isAbsolute(v['--forget-socket'])) throw new Fail(2, `--forget-socket must be an absolute socket path, got ${JSON.stringify(v['--forget-socket'])}`);
    const extra = ['--name', '--checkout', '--session', '--attach-timeout'].filter((f) => v[f] !== undefined).concat(args.dryRun ? ['--dry-run'] : [], args.detached ? ['--detached'] : []);
    if (extra.length > 0) throw new Fail(2, `--forget-socket takes only --target; drop ${extra.join(', ')}`);
    args.forgetSocket = v['--forget-socket'];
    return args;
  }
  if ((args.name === undefined) === (args.checkout === undefined)) throw new Fail(2, `give exactly one of --name and --checkout\n${USAGE}`);
  return args;
}

/**
 * The tmux session name of a checkout's OpenCode window: the name the checkout's generated launcher uses
 * (scripts/lib/launchers.mjs sessionName, plus -opencode), so that launcher reattaches to it. No dot or colon.
 */
export const windowName = (folder) => `${sessionName(folder)}-opencode`;

/** The arguments that open `terminal` on the guarded attach of session `target` (its id) on the server at `socket`. */
export function terminalCommand(terminal, folder, socket, target, server) {
  const attach = ['bash', '-c', 'tmux "$@" || read -rp "tmux attach failed. Press Enter to close. "', '_', ...guardedCommand(socket, server, `attach-session -t '${target}'`)];
  switch (terminal) {
    case 'ghostty': return [`--working-directory=${folder}`, '-e', ...attach];
    case 'gnome-terminal': return [`--working-directory=${folder}`, '--', ...attach];
    case 'kitty': return ['--directory', folder, ...attach];
    case 'konsole': return ['--workdir', folder, '-e', ...attach];
    default: return ['-e', ...attach];
  }
}

const tmuxAt = (socket) => `tmux -S ${shq(socket)}`;
const attachCommand = (socket, id, name) => `${tmuxAt(socket)} attach-session -t ${shq(id)} (the session ${name})`;
const describeSessions = (sessions) => sessions.map((s) => `${s.name} (${s.id}, ${s.attached > 0 ? 'attached' : 'detached'}, folder ${s.dir})`).join(', ');

function serverRestarted(server, socket, id) {
  return new Stop('server_restarted', `the tmux server at ${socket} is no longer process ${server.pid} started at ${server.start}; session ${id} may belong to another server, refusing changes, attachment or verification`, { socket, windowId: id, serverPid: server.pid, serverStart: server.start });
}

function checkServer(sessions, server, socket, id) {
  if (sessions.some((s) => !sameServer(s, server))) throw serverRestarted(server, socket, id);
}

async function tmuxOk(deps, args, what) {
  const r = await deps.tmux(args);
  if (r.code !== 0) throw new Error(`${what}: tmux ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

async function waitFor(deps, seconds, probe) {
  const end = deps.now() + seconds * 1000;
  for (;;) {
    if (await probe(deps)) return true;
    if (deps.now() >= end) return false;
    await deps.sleep(POLL_MS);
  }
}

// The OpenCode pane of the session `id`: its only pane, running OpenCode by the shared pane check.
async function openCodePane(deps, socket, id) {
  const out = await tmuxOk(deps, ['-S', socket, 'list-panes', '-s', '-t', id, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_start_command}'], `panes of ${id}`);
  const panes = out.split('\n').filter((l) => l !== '').map((l) => {
    const [pane, pid, ...cmd] = l.split('\t');
    return { id: pane, pid, cmd: cmd.join('\t') };
  });
  if (panes.length !== 1 || !/^%\d+$/.test(panes[0].id) || !/^[1-9]\d*$/.test(panes[0].pid)) return null;
  return isOpencodeCommand(panes[0].cmd) ? { id: panes[0].id } : null;
}

// The project: its main checkout, its registry name (the inventory attributes sessions by the registry) and its settings.
async function projectOf(deps, args) {
  let mainRoot;
  try {
    mainRoot = deps.resolveMain(args.target);
  } catch (e) {
    // open-session's SessionRefusal: its exit code (2 refused, 1 a git step failed) and message.
    if (Number.isInteger(e?.exit)) throw new Fail(e.exit, e.message);
    throw e;
  }
  const canonicalRoot = await canonical(deps.realpath, mainRoot, 'the main checkout');
  const settings = deps.readMultiSession(canonicalRoot);
  if (!settings.enabled) throw new Stop('multi_session_off', multiSessionRefusal('opening a session window'), {}, 2);
  const registry = await deps.listProjects();
  const names = [];
  for (const row of registry) {
    if (typeof row?.repo_path !== 'string' || !isAbsolute(row.repo_path)) continue;
    let real;
    try {
      real = await deps.realpath(row.repo_path);
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') continue;
      throw new Fail(1, `cannot resolve the registered project ${row.name} (${row.repo_path}): ${e?.message ?? e}`);
    }
    if (real === canonicalRoot) names.push(row);
  }
  if (names.length === 0) throw new Fail(2, `${canonicalRoot} is not a registered Sterling project (run /sterling:init there); the session inventory needs its registry name`);
  if (new Set(names.map((r) => r.name)).size > 1) throw new Fail(1, `${canonicalRoot} is registered under ${names.length} names (${names.map((r) => r.name).join(', ')}); ambiguous`);
  return { project: names[0].name, root: names[0].repo_path, canonicalRoot, registry, maxSessions: settings.max_sessions };
}

async function checkoutFolder(deps, args, ctx) {
  const given = args.checkout ?? worktreePathFor(ctx.canonicalRoot, args.name);
  let folder;
  try {
    folder = await deps.realpath(given);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') throw new Stop('checkout_missing', `${given} does not exist; create the session worktree first with open-session.mjs${args.name ? ` --name ${args.name}` : ''}`);
    throw new Fail(1, `cannot resolve the checkout ${given}: ${e?.message ?? e}`);
  }
  if (checkoutOf(folder, { main: ctx.canonicalRoot }) !== null) throw new Stop('main_checkout', `${folder} is in the main checkout of ${ctx.project}; its window is opened by its own sterling-launch.sh`);
  const registered = await sessionCheckouts(deps, ctx.root, ctx.canonicalRoot);
  if (!registered.some((c) => c.key === folder)) {
    throw new Stop('not_a_session_checkout', `${folder} is not a session worktree of ${ctx.project}: only a direct child of ${ctx.canonicalRoot}.worktrees/ that git registers as a worktree of the project is one`);
  }
  const nested = nestedCheckout(registered, folder);
  if (nested) throw new Stop('nested_checkout', `${folder} nests with the session worktree ${nested.key}, so the sessions of the two cannot be told apart`);
  if (!deps.exists(join(folder, AGENT_REL))) {
    throw new Stop('agents_missing', `${folder} has no ${AGENT_REL}, so OpenCode would not find the Sterling conductor there (anti-pattern 63e3b8c3); run /sterling:update in that worktree, or remove it and open it again with open-session.mjs`);
  }
  return { folder, shape: { main: ctx.canonicalRoot, sessions: registered.map((c) => c.key) } };
}

// The OpenCode binary, as an absolute plain path the pane check will read as OpenCode.
function openCodeBinary(deps) {
  let bin = deps.opencodeBin();
  if (!isAbsolute(bin)) {
    const found = deps.findExecutable(bin);
    if (!found) throw new Stop('opencode_binary', `OPENCODE_BIN ${JSON.stringify(bin)} is not an absolute path and is not on PATH`);
    bin = found;
  }
  if (!PLAIN_PATH_RE.test(bin) || basename(bin) !== 'opencode') {
    throw new Stop('opencode_binary', `${JSON.stringify(bin)} is not a plain absolute path to a binary called opencode (letters, digits and . _ / @ + - only), so tmux could not carry it and the pane check would not read the window as OpenCode`);
  }
  return bin;
}

function attachPlan(args, deps) {
  if (args.detached) return { how: 'detached' };
  if (deps.isTTY && !deps.env.TMUX) return { how: 'inline' };
  const terminal = TERMINALS.find((t) => deps.findExecutable(t));
  if (!terminal || !deps.findExecutable('setsid')) {
    throw new Stop('no_terminal', `this is not a terminal outside tmux and ${terminal ? 'setsid' : `none of ${TERMINALS.join(', ')}`} was found to open one; run it from a terminal, or pass --detached and attach ${deps.env.TMUX ? 'from another terminal' : 'yourself'}`);
  }
  return { how: 'terminal', terminal, file: deps.findExecutable(terminal) };
}

// --session: the session must exist, be a top-level conductor and run in this checkout. What cannot be read is
// conductor_unknown, never taken for a yes.
async function checkSession(deps, id, { folder, shape }) {
  const path = `/api/session/${id}`;
  try {
    const info = (await getJson(deps.api, path))?.data;
    if (info?.id !== id) throw new Fail(1, `GET ${path} answered for ${JSON.stringify(info?.id)}`);
    if (!isConductorCandidate(info)) {
      const why = info.parentID != null ? `it is a subagent of ${info.parentID}` : info.time?.archived ? 'it is archived' : `its agent is ${JSON.stringify(info.agent)}, not sterling/conductor`;
      throw new Stop('session_not_conductor', `session ${id} is not a top-level conductor session (${why}), so it is not resumed as the conductor of ${folder}`);
    }
    const dir = info.location?.directory;
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Fail(1, `GET ${path} gives no usable folder (${JSON.stringify(dir)})`);
    let real;
    try {
      real = await deps.realpath(dir);
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') throw new Stop('session_other_checkout', `session ${id} runs in ${dir}, which no longer exists, so it is no conductor of ${folder}`);
      throw new Fail(1, `cannot resolve the folder ${dir} of session ${id}: ${e?.message ?? e}`);
    }
    const where = checkoutOf(real, shape);
    if (where !== folder) throw new Stop('session_other_checkout', `session ${id} runs in ${real}, ${where === null ? 'in no checkout of this project' : `in the checkout ${where}`}, not in ${folder}`);
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    if (e.httpStatus === 404) throw new Stop('session_not_found', `OpenCode has no session ${id}, so there is nothing to resume`);
    throw new Stop('conductor_unknown', `${e.message}, so it is not known whether session ${id} is a conductor of ${folder}`);
  }
}

// One conductor per checkout: read the project's sessions with the shared inventory, refuse while a conductor of THIS
// checkout is live, and hand back the live conductors of the other checkouts for the ceiling count. Nothing here writes.
async function inventory(deps, args, ctx, checkout) {
  const verdict = await readProjectInventory(deps, ctx.registry, ctx.project, undefined);
  if (verdict.unknown) {
    throw new Stop('conductor_unknown', `the sessions of ${ctx.project} could not all be read, so it is not known whether a conductor of ${checkout.folder} is live or how many sessions run; refusing, as an unknown state is never taken for a free checkout`);
  }
  const live = verdict.live.filter((c) => typeof c.checkout === 'string' && c.id !== args.session);
  const here = live.filter((c) => c.checkout === checkout.folder);
  if (here.length > 0) {
    const named = here.map((c) => `${c.id} (${c.why.join('; ')})`).join(', ');
    throw new Stop('conductor_live', `a conductor of ${checkout.folder} is live: ${named}; ${args.session ? `resuming ${args.session} beside it` : 'a blank session there'} would be a second conductor in one checkout. Close it first${args.session ? '' : `, or pass --session ${here[0].id} to move that conductor into this window`}`, { conductors: here.map(({ id, why }) => ({ id, why })) });
  }
  return live;
}

// What occupies the project's checkouts right now, all read inside the admission lock and under its one deadline
// (launch-admission.mjs OBSERVE_MS): the fresh API inventory (which also refuses a live conductor of the target), and
// one reading of every socket the admission asks for, with each OpenCode window in a checkout of the project and any
// session at the target folder or with the target name. Whether an unanswered socket may be taken as empty is the
// admission's judgment (its socket registry), never this reader's.
function observer(deps, args, ctx, checkout, name) {
  const { folder, shape } = checkout;
  return async ({ sockets }) => {
    const live = await inventory({ ...deps, deadline: deps.now() + IN_LOCK_READ_MS }, args, ctx, checkout);
    const readings = {};
    for (const at of sockets) {
      const rd = await readServer(deps, at);
      if (rd.state !== 'running') {
        readings[at] = rd;
        continue;
      }
      const identities = new Set(rd.sessions.map((s) => `${s.serverPid}\t${s.serverStart}`));
      if (identities.size > 1) {
        readings[at] = { state: 'unreadable', why: `tmux -S ${at} listed sessions of more than one server (it restarted while it was read)` };
        continue;
      }
      const windows = [];
      for (const s of rd.sessions) {
        if (s.dir === folder || s.name === name) windows.push({ checkout: folder, id: s.id, detail: `${s.name} (${s.id} on ${at}, ${s.attached > 0 ? 'attached' : 'detached'})` });
        else if (rd.opencode.has(s.id)) {
          const where = checkoutOf(s.dir, shape);
          if (where !== null) windows.push({ checkout: where, id: s.id, detail: `${s.name} (${s.id} on ${at})` });
        }
      }
      const first = rd.sessions[0];
      readings[at] = { state: 'running', server: first ? { pid: first.serverPid, start: first.serverStart } : null, windows, sessionIds: rd.sessions.map((s) => s.id) };
    }
    return { conductors: live.map((c) => ({ checkout: c.checkout, detail: `${c.id} (${c.why.join('; ')})` })), readings };
  };
}

// A session for this folder appeared around the creation: two windows on it. Neither is touched; `killed` is always false.
function conflict({ id, name, folder, others, socket }) {
  const tmux = tmuxAt(socket);
  const closing = [['the new session', id], ...others.map((s) => [s.name, s.id])].map(([which, sid]) => `${which} with ${tmux} kill-session -t ${shq(sid)}`).join(', or ');
  return new Stop('window_conflict', `tmux session ${name} (${id}) was created for ${folder}, but ${describeSessions(others)} ${others.length === 1 ? 'is' : 'are'} on that folder already. Everything is left running and nothing was attached: this script never kills a session, because a client can attach to one between any look at it and the kill. Close one of them by hand, after looking with ${tmux} list-sessions at which of them a client is attached: ${closing}`, {
    socket,
    created: { id, name },
    others: others.map((s) => ({ id: s.id, name: s.name, folder: s.dir, attached: s.attached })),
    killed: false,
  });
}

export async function openSessionWindow(args, rawDeps) {
  if (rawDeps.platform !== 'linux') throw new Stop('unsupported_platform', `the session-window launcher runs on Linux (WSL included) with tmux only; this is ${rawDeps.platform}`);
  if (!rawDeps.findExecutable('tmux')) throw new Stop('no_tmux', 'tmux is not on PATH; the session-window launcher needs it');
  const deps = { ...rawDeps, deadline: rawDeps.now() + RUN_SLACK_MS + args.attachTimeout * 1000 };
  let socket;
  try {
    socket = environmentSocket(deps.env, deps.uid);
  } catch (e) {
    throw new Stop('tmux_unreadable', `${e.message}; refusing rather than guessing the tmux server`);
  }
  const ctx = await projectOf(deps, args);
  const checkout = await checkoutFolder(deps, args, ctx);
  const { folder } = checkout;
  const name = windowName(folder);

  // A cheap early refusal on the server this launch uses; the locked admission looks again, on every server that matters.
  const clash = (await listSessions(deps, socket)).filter((s) => s.name === name || s.dir === folder);
  if (clash.length > 0) {
    throw new Stop('window_exists', `tmux session ${clash.map((s) => `${s.name} (${s.attached > 0 ? 'attached' : 'detached'}, folder ${s.dir})`).join(', ')} on ${socket} already is or stands in the place of this checkout's window; not attaching to it and starting nothing`);
  }
  const bin = openCodeBinary(deps);
  const command = [bin, ...(args.session ? ['--session', args.session] : [])];
  const plan = attachPlan(args, deps);
  // Which session --session names is identity, not occupancy: it is checked before the lock.
  if (args.session) await checkSession(deps, args.session, checkout);
  const tmuxArgs = ['-S', socket, 'new-session', '-d', '-P', '-F', '#{session_id}\t#{pid}\t#{start_time}', '-s', name, '-c', folder, ...command];
  const shown = { project: ctx.project, folder, window: name, command, resume: args.session ?? null, attach: plan.how === 'terminal' ? `terminal:${plan.terminal}` : plan.how, socket, max_sessions: ctx.maxSessions };

  const admission = await deps.admit(ctx.canonicalRoot, { checkout: folder, socket, alsoRead: [defaultSocket(deps.env, deps.uid)], maxSessions: ctx.maxSessions, observe: observer(deps, args, ctx, checkout, name), observeMs: IN_LOCK_READ_MS, dryRun: args.dryRun, now: deps.now });
  if (!admission.admitted) throw new Stop(admission.reason, admission.why, { counted: admission.counted, ...(admission.socket ? { socket: admission.socket } : {}) });
  if (args.dryRun) return { status: 'would_start', ...shown, counted: admission.counted, tmux: tmuxArgs };

  // The reservation is settled once: released while nothing was created, else started or uncertain. A started settle
  // is final: a later failure (the terminal, the attach wait) leaves it counted until its window is seen gone.
  const reservation = admission.id;
  let settled = null;
  const settle = async (outcome, detail = {}) => {
    if (settled === 'started') return {};
    settled = outcome;
    try {
      await deps.settle(ctx.canonicalRoot, reservation, outcome, { checkout: folder, socket, detail, now: deps.now });
      return {};
    } catch (e) {
      return { reservationError: `the launch reservation ${reservation} could not be settled ${outcome} (${e?.message ?? e}); it stays counted as reserved until it expires` };
    }
  };
  try {
    return await create(deps, args, { name, folder, socket, shown, plan, tmuxArgs, settle });
  } finally {
    if (settled === null) await settle('released');
  }
}

async function create(deps, args, { name, folder, socket, shown, plan, tmuxArgs, settle }) {
  // A nonzero client result does not prove the server rejected the creation; only a definite tmux rejection without
  // creation output is safe to report as not started. Never retry the creation.
  let creation;
  try {
    creation = await deps.tmux(tmuxArgs);
  } catch (e) {
    creation = { code: null, stdout: '', stderr: String(e?.message ?? e) };
  }
  const printed = creation.stdout ?? '';
  if (creation.code !== 0) {
    const error = `starting the window: tmux new-session failed (${creation.code}): ${(creation.stderr || printed).trim()}`;
    if (creation.code === 1 && printed.trim() === '' && /^(?:duplicate session:|usage: new-session\b|command new-session: (?:(?:invalid|unknown) (?:flag|option)\b|-\S+ expects an argument$))/.test((creation.stderr || '').trim())) {
      await settle('released');
      throw new Fail(1, error);
    }
    const [partialId, partialPid, partialStart] = printed.trim().split('\t');
    const windowId = TMUX_ID_RE.test(partialId ?? '') ? partialId : null;
    const serverPid = DIGITS_RE.test(partialPid ?? '') ? partialPid : null;
    const serverStart = DIGITS_RE.test(partialStart ?? '') ? partialStart : null;
    const kept = await settle('uncertain', { windowId, serverPid, serverStart, window: name });
    const note = `OpenCode may already be running in tmux session ${name} for ${folder}; inspect the server shown by ${tmuxAt(socket)} list-sessions for that session before any retry; this script never retries or kills it, and the launch stays counted against max_sessions until it is seen or expires`;
    return { status: 'start_uncertain', ...shown, uncertain: ['new-session'], windowId, serverPid, serverStart, creationOutput: printed, error, note, ...kept };
  }
  const [id, serverPid, serverStart] = printed.trim().split('\t');
  if (!TMUX_ID_RE.test(id ?? '') || !DIGITS_RE.test(serverPid ?? '') || !DIGITS_RE.test(serverStart ?? '')) {
    await settle('uncertain', { window: name });
    throw new Started(name, null, `tmux started the session ${name} but printed ${JSON.stringify(printed)}, not its session id, server pid and server start time, so it cannot be told from another session or server`, socket);
  }
  const server = { pid: serverPid, start: serverStart };
  const detail = { windowId: id, serverPid, serverStart, window: name };
  try {
    const configured = await deps.tmux(guardedCommand(socket, server, `set-option -t '${id}' mouse on`));
    if (configured.stdout.trim() === 'server_restarted') throw serverRestarted(server, socket, id);
    if (configured.code !== 0) throw new Error(`setting mouse on: tmux set-option failed: ${(configured.stderr || configured.stdout).trim()}`);
    const sessions = await listSessions(deps, socket);
    checkServer(sessions, server, socket, id);
    const made = sessions.find((s) => s.id === id);
    const others = sessions.filter((s) => s.id !== id && s.dir === folder);
    if (!made) throw new Error(`tmux session ${name} (${id}) is not listed right after it was created (OpenCode may have exited at once)${others.length > 0 ? `; another session is on the folder: ${describeSessions(others)}` : ''}`);
    if (others.length > 0) throw conflict({ id, name, folder, others, socket });
    if (made.name !== name || made.dir !== folder) throw new Error(`tmux session ${id} is now ${made.name} in ${made.dir}, not the ${name} in ${folder} this run created`);
    if (made.windows !== 1) throw new Error(`tmux session ${name} (${id}) has ${made.windows} windows, expected 1`);
    const pane = await openCodePane(deps, socket, id);
    if (!pane) throw new Error(`tmux session ${name} (${id}) does not hold exactly one OpenCode pane`);
    const kept = await settle('started', detail);
    const done = { ...shown, windowId: id, serverPid, serverStart, pane: pane.id, ...kept };
    if (plan.how === 'inline') return { status: 'started', ...done };
    if (plan.how === 'detached') return { status: 'started', ...done, attached: false, note: `no terminal is attached; attach with ${attachCommand(socket, id, name)}` };
    const env = { ...deps.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    await deps.spawnTerminal('setsid', ['-f', plan.file, ...terminalCommand(plan.terminal, folder, socket, id, server)], { env, cwd: folder });
    const seen = await waitFor(deps, args.attachTimeout, async (d) => {
      const now = await listSessions(d, socket);
      checkServer(now, server, socket, id);
      const s = now.find((x) => x.id === id);
      if (!s) throw new Error(`tmux session ${name} (${id}) is gone, so the terminal has nothing to attach to`);
      return s.attached > 0;
    });
    if (seen) return { status: 'started', ...done, attached: true };
    return { status: 'started_unattached', ...done, attached: false, note: `no terminal attached within ${args.attachTimeout} s; the session is left running: ${attachCommand(socket, id, name)}` };
  } catch (e) {
    // The window exists (a conflict included) or may: it stays counted (settle keeps a started reservation as it is).
    await settle(e instanceof Stop && e.reason === 'window_conflict' ? 'started' : 'uncertain', detail);
    if (e instanceof Stop) throw e;
    throw new Started(name, id, e?.message ?? String(e), socket, server);
  }
}

// --forget-socket: the operator drops one socket from the project's registry, with every reservation that names it, under
// the admission lock. Cleanup, so it runs with multi_session off too. Nothing registered under that path is exit 1.
async function forget(args, deps, io) {
  let mainRoot;
  try {
    mainRoot = deps.resolveMain(args.target);
  } catch (e) {
    if (Number.isInteger(e?.exit)) throw new Fail(e.exit, e.message);
    throw e;
  }
  const root = await canonical(deps.realpath, mainRoot, 'the main checkout');
  const r = await deps.forget(root, args.forgetSocket);
  if (!r.entry && r.reservations.length === 0) {
    io.stdout(`${JSON.stringify({ status: 'not_registered', socket: r.socket })}\n`);
    io.stderr(`open-session-window: ${r.socket} is not in the socket registry of ${root} and no launch reservation names it; nothing was forgotten\n`);
    return 1;
  }
  io.stdout(`${JSON.stringify({ status: 'forgotten', socket: r.socket, server: r.entry?.server ?? null, reservations: r.reservations.map((x) => ({ id: x.id, checkout: x.checkout, state: x.state })) })}\n`);
  const server = r.entry?.server ? `recorded server pid ${r.entry.server.pid} (started ${r.entry.server.start})` : 'no recorded server';
  io.stderr(`open-session-window: forgot the tmux socket ${r.socket} (${server}) and ${r.reservations.length} reservation${r.reservations.length === 1 ? '' : 's'} naming it${r.reservations.map((x) => `: ${x.id} for ${x.checkout} (${x.state})`).join('')}; windows on that server are no longer counted against max_sessions\n`);
  return 0;
}

export async function main(argv, deps, io) {
  let project;
  try {
    const args = parseArgs(argv);
    if (args.forgetSocket) return await forget(args, deps, io);
    const result = await openSessionWindow(args, deps);
    project = result.project;
    io.stdout(`${JSON.stringify(result)}\n`);
    if (result.status === 'started_unattached' || result.status === 'start_uncertain') {
      io.stderr(`open-session-window: ${result.error ? `${result.error}; ` : ''}${result.note}\n`);
      return 1;
    }
    if (result.reservationError) io.stderr(`open-session-window: ${result.reservationError}\n`);
    // The terminal is taken over until the user detaches, so the result is printed first.
    if (result.status === 'started' && result.attach === 'inline') {
      const server = { pid: result.serverPid, start: result.serverStart };
      const code = await deps.attachInline(result.windowId, result.socket, server);
      checkServer(await listSessions(deps, result.socket), server, result.socket, result.windowId);
      return code;
    }
    return 0;
  } catch (e) {
    if (e instanceof Stop) {
      io.stdout(`${JSON.stringify({ status: 'refused', project, reason: e.reason, why: e.why, ...e.detail })}\n`);
      io.stderr(`open-session-window: ${e.message}\n`);
      return e.exit;
    }
    if (e instanceof Started) {
      const note = 'the tmux session was created and is left as it is: look at it before running again; this script never retries or kills it';
      io.stdout(`${JSON.stringify({ status: 'started_unverified', project, window: e.window, windowId: e.id, socket: e.socket, serverPid: e.server?.pid ?? null, serverStart: e.server?.start ?? null, error: e.message, note })}\n`);
      io.stderr(`open-session-window: ${e.message}; ${note}\n`);
      return 1;
    }
    const code = e instanceof Fail ? e.code : 1;
    const error = String(e?.message ?? e);
    io.stdout(`${JSON.stringify({ status: 'failed', project, code, error })}\n`);
    io.stderr(`open-session-window: ${error}\n`);
    return code;
  }
}

// The first executable called `name` on PATH, or null.
function findExecutable(name, env = process.env) {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e?.code)) throw e;
    }
  }
  return null;
}

// tmux with the server the environment selects; partial stdout is kept on a timeout, which is never a definite rejection.
function runTmux(args) {
  return new Promise((done) => {
    execFile('tmux', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout, stderr });
      done({ code: typeof err.code === 'number' ? err.code : 124, stdout: stdout ?? '', stderr: stderr || String(err.message) });
    });
  });
}

export function launcherDeps() {
  return {
    ...realDeps(),
    platform: process.platform,
    uid: process.getuid?.(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exists: (p) => existsSync(p),
    readMultiSession,
    // --target as open-session reads it (a registry name or a path); without it the current folder's project.
    resolveMain: (target) => resolveMainCheckout(target === undefined ? process.cwd() : resolveTarget(target)),
    opencodeBin: () => process.env.OPENCODE_BIN || defaultOpencodeBin(),
    findExecutable: (name) => findExecutable(name),
    tmux: runTmux,
    admit: admitLaunch,
    settle: settleLaunch,
    forget: forgetSocket,
    // A terminal that outlives this process: setsid -f detaches it.
    spawnTerminal: (file, args, { env, cwd }) => new Promise((ok, fail) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', env, cwd });
      child.once('error', fail);
      child.once('spawn', () => {
        child.unref();
        ok();
      });
    }),
    // Attaches this terminal to the session `target` (its id) on the server `socket` names, behind the pid guard.
    attachInline: (target, socket, server) => new Promise((done) => {
      const child = spawn('tmux', guardedCommand(socket, server, `attach-session -t '${target}'`), { stdio: 'inherit' });
      child.once('error', (e) => {
        process.stderr.write(`open-session-window: cannot run tmux attach-session: ${e.message}\n`);
        done(1);
      });
      child.once('close', (code) => done(code ?? 1));
    }),
  };
}

// import.meta.url names this scripts/ source when bundled into bin/ (source-location identity), so the guard accepts both
// launch paths (anti-pattern 6b1c51f4).
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs === fileURLToPath(import.meta.url) || launchedAs === fileURLToPath(new URL('../bin/open-session-window.mjs', import.meta.url))) {
  const io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  main(process.argv.slice(2), launcherDeps(), io).then((code) => {
    process.exitCode = code;
  });
}
