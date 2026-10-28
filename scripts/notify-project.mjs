#!/usr/bin/env node
// Send a message to another registered project's owner conductor session through the OpenCode API
// (multi-session toolkit slice 3, decision sterling-ports-ch-hub-s-whole-multi-session-toolkit-session;
// ported from CH.Hub's scripts/notify-project.mjs without the hub). Never as typed tmux keys, which reach
// whatever session a window happens to show.
//
//   node bin/notify-project.mjs --project <registry name> [--checkout <folder>] --text <text> [--dry-run]
//   node bin/notify-project.mjs --all --text <text> [--dry-run]
//
// The text goes, prefixed with the sending project's name, as one queued prompt to the recorded owner of the
// target checkout (scripts/lib/owner-record.mjs) and to no other session. It passes the same admission as a
// wake (scripts/lib/owner-session.mjs), except that another live conductor of the checkout does not refuse
// it: the point is to reach the owner. It is journaled before the POST (scripts/lib/delivery-journal.mjs):
// after a `sent: maybe` result, run the SAME command again; it looks the prompt up and resends it with the
// same message id only when it is absent, so the owner never sees it twice.
//
// --all sends to every other registered project whose main checkout has an owner record and whose
// multi_session is on; the others are listed as skipped. One JSON line per project. Exit 0 only when every
// destination was queued (or found delivered); exit 2 for bad arguments.
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fail, deliver, realDeps, senderName } from './lib/owner-session.mjs';
import { projectContext } from './lib/session-inventory.mjs';

export const noticeText = (sender, text) => `[Sterling notice from project ${sender}] ${text}`;

const USAGE = 'usage: notify-project.mjs (--project <registry name> [--checkout <folder>] | --all) --text <message> [--dry-run]\n'
  + 'After a sent: maybe result, run the same command again: it resends with the same message id only when the prompt is absent.';
const OWN_FLAGS = new Set(['--project', '--text', '--all', '--dry-run', '--checkout']);

export function parseArgs(argv) {
  const args = { dryRun: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--all') args.all = true;
    else if (a === '--project' || a === '--text' || a === '--checkout') {
      const v = argv[++i];
      // A message may start with dashes; only this script's own flags are refused as a value.
      if (v === undefined || (a === '--text' ? OWN_FLAGS.has(v) : v.startsWith('--'))) throw new Fail(2, `${a} needs a value`);
      args[a.slice(2)] = v;
    } else throw new Fail(2, `unknown argument '${a}'\n${USAGE}`);
  }
  if (args.text === undefined || args.text.trim() === '') throw new Fail(2, USAGE);
  if (args.all === (args.project !== undefined)) throw new Fail(2, 'give either --project <registry name> or --all');
  if (args.all && args.checkout !== undefined) throw new Fail(2, '--checkout is for one project: it does not combine with --all');
  return args;
}

const exitOf = (r) => (['queued', 'delivered', 'would_queue', 'skipped'].includes(r.status) ? 0 : r.status === 'failed' ? r.code : 1);
const note = (r) => `${r.project}: ${r.status === 'refused' ? `${r.reason}: ${r.why}` : r.error ?? r.status}`;

// The --all destinations: every registered project but the sender with an owner record in its main checkout and
// multi_session on. The rest are skipped, each with its reason.
async function allTargets(deps, registry, sender) {
  const targets = [];
  const skipped = [];
  for (const name of [...new Set(registry.map((r) => r.name))]) {
    if (name === sender) continue;
    try {
      const ctx = await projectContext(deps, registry, name);
      if (!deps.readMultiSession(ctx.root).enabled) skipped.push({ project: name, status: 'skipped', reason: 'multi_session_off' });
      else if (deps.readOwner(ctx.root) === null) skipped.push({ project: name, status: 'skipped', reason: 'no_owner' });
      else targets.push(name);
    } catch {
      targets.push(name); // its own delivery reports what cannot be read
    }
  }
  return { targets, skipped };
}

export async function main(argv, deps, io) {
  try {
    const args = parseArgs(argv);
    const registry = await deps.listProjects();
    const sender = await senderName(deps, registry);
    const text = noticeText(sender, args.text);
    const one = (project) => deliver('notify', { project, checkout: args.checkout, dryRun: args.dryRun, body: args.text }, deps, registry, text);
    let results;
    if (args.all) {
      const { targets, skipped } = await allTargets(deps, registry, sender);
      results = [];
      for (const project of targets) results.push(await one(project));
      results.push(...skipped);
    } else {
      results = [await one(args.project)];
    }
    for (const r of results) {
      io.stdout(`${JSON.stringify(r)}\n`);
      if (exitOf(r) !== 0) io.stderr(`notify-project: ${note(r)}\n`);
    }
    if (!args.all) return exitOf(results[0]);
    return results.every((r) => exitOf(r) === 0) ? 0 : 1;
  } catch (e) {
    const code = e instanceof Fail ? e.code : 1;
    io.stdout(`${JSON.stringify({ status: 'failed', sent: 'none', code, error: String(e?.message ?? e) })}\n`);
    io.stderr(`notify-project: ${e?.message ?? e}\n`);
    return code;
  }
}

// import.meta.url names this scripts/ source inside the bin/ bundle (hazard 6b1c51f4).
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs && (launchedAs === fileURLToPath(import.meta.url) || basename(launchedAs) === 'notify-project.mjs')) {
  const io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  process.exitCode = await main(process.argv.slice(2), realDeps(), io);
}
