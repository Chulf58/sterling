#!/usr/bin/env node
// Wake another registered project's owner conductor session, and keep the per-checkout owner records
// (multi-session toolkit slice 3, decision sterling-ports-ch-hub-s-whole-multi-session-toolkit-session;
// ported from CH.Hub's scripts/wake-project.mjs without the hub).
//
//   node bin/wake-project.mjs --project <registry name> [--checkout <folder>] [--dry-run]
//   node bin/wake-project.mjs --set-owner --project <registry name> --session <full id> [--checkout <folder>]
//   node bin/wake-project.mjs --show-owners [--project <registry name> [--checkout <folder>]]
//
// A wake queues one fixed prompt (delivery 'queue') into the recorded owner of the main checkout, or of the
// session worktree --checkout names (a direct child of <main folder>.worktrees/ that git registers; any other
// folder is exit 2). The owner is the target checkout's own record (scripts/lib/owner-record.mjs): the root
// session the user last prompted there, which the Sterling plugin records, or one set with --set-owner. A wake
// never elects an owner. It is refused, with nothing sent, when the target project has multi_session off, no
// owner is recorded or the owner is unusable, the owner or any session of its tree is working, a question form
// or permission request is open, input is queued, a shell command runs in a folder of its tree, another
// conductor of the checkout is live, or any of this cannot be read in full (scripts/lib/owner-session.mjs
// admission). Every prompt is journaled before it is sent (scripts/lib/delivery-journal.mjs); a run after an
// uncertain send looks the prompt up and resends it with the same message id only when it is absent.
//
// --set-owner changes a project's own record, so it runs only from a checkout of that project; it is a
// compare-and-set against the record it read before it checked the session. --show-owners reads files only
// and needs no server.
//
// Prints one JSON line. Exit 0: queued, delivered (found from an earlier uncertain send), would_queue,
// owner_set, the owner list. Exit 1: refused or failed. Exit 2: bad arguments, an unknown project or checkout.
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fail, Refused, deliver, realDeps, resolveCheckout, senderName, usableOwner } from './lib/owner-session.mjs';
import { checkSessionId, projectContext, sessionCheckouts, canonical, isUnder } from './lib/session-inventory.mjs';

export const wakeText = (sender) => `Sterling project ${sender} woke this session. Read your board (board_query, readiness ready) and work what is ready under your conductor rules: plan it, dispatch subagents for the reading and the work, and keep this session for decisions and review.`;

const USAGE = 'usage: wake-project.mjs --project <registry name> [--checkout <folder>] [--dry-run]\n'
  + '       wake-project.mjs --set-owner --project <registry name> --session <full session id> [--checkout <folder>]\n'
  + '       wake-project.mjs --show-owners [--project <registry name> [--checkout <folder>]]';

export function parseArgs(argv) {
  const args = { dryRun: false, setOwner: false, showOwners: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--set-owner') args.setOwner = true;
    else if (a === '--show-owners') args.showOwners = true;
    else if (a === '--project' || a === '--session' || a === '--checkout') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Fail(2, `${a} needs a value`);
      args[a.slice(2)] = v;
    } else throw new Fail(2, `unknown argument '${a}'\n${USAGE}`);
  }
  if (args.showOwners && args.setOwner) throw new Fail(2, '--show-owners and --set-owner do not combine');
  if (args.showOwners) {
    if (args.dryRun) throw new Fail(2, '--show-owners does not take --dry-run');
    if (args.session !== undefined) throw new Fail(2, '--show-owners does not take --session');
    if (args.checkout !== undefined && args.project === undefined) throw new Fail(2, '--show-owners --checkout needs --project');
    return args;
  }
  if (args.setOwner) {
    if (args.dryRun) throw new Fail(2, '--set-owner does not take --dry-run');
    if (!args.project || !args.session) throw new Fail(2, 'usage: wake-project.mjs --set-owner --project <registry name> --session <full session id> [--checkout <folder>]');
    checkSessionId(args.session, '--session');
    return args;
  }
  if (args.session !== undefined) throw new Fail(2, '--session goes with --set-owner');
  if (!args.project) throw new Fail(2, USAGE);
  return args;
}

// --set-owner: the session must exist, be a top-level conductor session and run in the checkout. Only the
// project's own runtime changes its record, so the run must start in a checkout of that project.
export async function setOwner(args, deps) {
  const registry = await deps.listProjects();
  const ctx = await projectContext(deps, registry, args.project);
  const scope = await resolveCheckout(deps, ctx, args.checkout);
  const here = await canonical(deps.realpath, deps.cwd, 'the current folder');
  const shape = [scope.mainRoot, ...scope.all.map((c) => c.key)];
  if (!shape.some((key) => isUnder(here, key))) {
    throw new Refused('not_own_project', `--set-owner changes ${args.project}'s own owner record, so it runs from a checkout of ${args.project} (this run is in ${deps.cwd}); nothing written`);
  }
  const before = deps.readOwner(scope.root)?.session ?? null;
  const owner = await usableOwner(deps, args.session, scope);
  if (!owner.ok) throw new Refused('owner_unusable', `${owner.why}; nothing written`);
  const w = await deps.transitionOwner(scope.root, { expect: before, next: owner.id });
  if (w.status !== 'written') {
    throw new Refused('owner_changed', `the owner record changed from ${before ?? 'none'} to ${w.current ?? 'none'} while the session was checked; nothing written, run it again`);
  }
  return { status: 'owner_set', project: args.project, checkout: scope.canonicalRoot, session: owner.id, previous: w.previous, directory: owner.directory };
}

const ownerOf = (deps, root) => {
  try {
    return { owner: deps.readOwner(root) };
  } catch (e) {
    return { owner: null, error: e.message };
  }
};

// --show-owners: the owner record of every checkout of every registered project, or of one project or one checkout.
export async function showOwners(args, deps) {
  const registry = await deps.listProjects();
  const one = async (project) => {
    const ctx = await projectContext(deps, registry, project);
    if (args.checkout !== undefined) {
      const scope = await resolveCheckout(deps, ctx, args.checkout);
      return { project, checkouts: [{ checkout: scope.canonicalRoot, main: scope.main, ...ownerOf(deps, scope.root) }] };
    }
    const all = await sessionCheckouts(deps, ctx.root, ctx.canonicalRoot);
    return { project, checkouts: [{ checkout: ctx.canonicalRoot, main: true, ...ownerOf(deps, ctx.root) }, ...all.map((c) => ({ checkout: c.key, main: false, ...ownerOf(deps, c.raw) }))] };
  };
  if (args.project !== undefined) return one(args.project);
  const projects = [];
  for (const name of [...new Set(registry.map((r) => r.name))]) {
    try {
      projects.push(await one(name));
    } catch (e) {
      projects.push({ project: name, error: String(e?.message ?? e) });
    }
  }
  return { projects };
}

export async function wake(args, deps) {
  const registry = await deps.listProjects();
  return deliver('wake', { ...args, body: 'wake' }, deps, registry, wakeText(await senderName(deps, registry)));
}

const exitOf = (r) => (['queued', 'delivered', 'would_queue', 'owner_set'].includes(r.status) ? 0 : r.status === 'failed' ? r.code : 1);

export async function main(argv, deps, io) {
  try {
    const args = parseArgs(argv);
    if (args.showOwners) {
      io.stdout(`${JSON.stringify(await showOwners(args, deps))}\n`);
      return 0;
    }
    const result = args.setOwner ? await setOwner(args, deps) : await wake(args, deps);
    io.stdout(`${JSON.stringify(result)}\n`);
    if (exitOf(result) !== 0) io.stderr(`wake-project: ${result.status === 'refused' ? `${result.reason}: ${result.why}` : result.error}\n`);
    return exitOf(result);
  } catch (e) {
    if (e instanceof Refused) {
      io.stdout(`${JSON.stringify({ status: 'refused', reason: e.reason, why: e.why })}\n`);
      io.stderr(`wake-project: ${e.reason}: ${e.why}\n`);
      return 1;
    }
    const code = e instanceof Fail ? e.code : 1;
    io.stdout(`${JSON.stringify({ status: 'failed', code, sent: 'none', error: String(e?.message ?? e) })}\n`);
    io.stderr(`wake-project: ${e?.message ?? e}\n`);
    return code;
  }
}

// import.meta.url names this scripts/ source inside the bin/ bundle (hazard 6b1c51f4), so the guard accepts the
// source and any file named wake-project.mjs (the shipped bundle).
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs && (launchedAs === fileURLToPath(import.meta.url) || basename(launchedAs) === 'wake-project.mjs')) {
  const io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  // exitCode, never process.exit: a large JSON line on a pipe must drain first (hazard b5b3f7db).
  process.exitCode = await main(process.argv.slice(2), realDeps(), io);
}
