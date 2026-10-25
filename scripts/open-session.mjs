// /sterling:session: open an extra parallel session in ANY Sterling project, one git
// worktree per session (decision
// parallel-sessions-in-one-project-run-one-per-git-worktree-sh).
//   node scripts/open-session.mjs [--target <project>] [--name <label>]
//   node scripts/open-session.mjs [--target <project>] --remove <label>
// Create: `git worktree add -b session/<label> <main>/../<project>.worktrees/<label>
// <default branch>`, then the same OpenCode setup /sterling:update runs (setupOpenCode),
// aimed at the worktree, then print the command that starts OpenCode IN it. A session is
// started in its worktree, never moved there (anti-pattern
// moving-an-opencode-session-into-a-git-worktree-loses-the-sterling-agent), and
// node_modules is neither symlinked nor installed there (anti-pattern e2a1fee8).
// Exit codes: 0 = done; 1 = a git step failed; 2 = refused or OpenCode setup incomplete
// (loud, nothing hidden).
// The worktree lives in a SIBLING directory, never inside the main tree: a nested
// worktree shows up as untracked content of the main checkout and makes every
// "which checkout am I in" lookup resolve to the wrong one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupOpenCode, formatOpenCodeRows } from './lib/opencode-install.mjs';
import { defaultBranch } from './lib/branch-manager.mjs';
import { resolveLinkedWorktree } from './lib/worktree-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

export class SessionRefusal extends Error {
  constructor(message, exit = 2) {
    super(message);
    this.exit = exit;
  }
}

const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BRANCH_PREFIX = 'session/';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: Infinity });
  if (r.error) throw new SessionRefusal(`git ${args.join(' ')} could not run in ${cwd}: ${r.error.message}`, 1);
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function gitOrThrow(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new SessionRefusal(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`, 1);
  return r.stdout;
}

/** The main checkout for a target directory (a linked worktree resolves to its main checkout). */
export function resolveMainCheckout(target) {
  const top = git(target, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new SessionRefusal(`${target} is not inside a git repository (${top.stderr.split('\n')[0]}); a parallel session needs one`);
  const linked = resolveLinkedWorktree(target);
  return linked ? linked.mainRoot : realpathSync(top.stdout);
}

/** <main>/../<project>.worktrees/<label>: a sibling of the main checkout, never nested in it. */
export function worktreePathFor(mainRoot, label) {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, label);
}

function checkLabel(label) {
  if (!LABEL_SHAPE.test(label)) {
    throw new SessionRefusal(`--name '${label}' is not a usable label: use letters, digits, '-' and '_', starting with a letter or digit`);
  }
}

const branchExists = (mainRoot, branch) => git(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;

function registeredWorktrees(mainRoot) {
  const out = gitOrThrow(mainRoot, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
}

/** The first session-N (N >= 2) with no worktree directory and no branch. */
function nextDefaultLabel(mainRoot) {
  for (let n = 2; ; n++) {
    const label = `session-${n}`;
    if (!existsSync(worktreePathFor(mainRoot, label)) && !branchExists(mainRoot, `${BRANCH_PREFIX}${label}`)) return label;
  }
}

/**
 * Create the worktree and bootstrap OpenCode in it. `setup` is injectable so a test can
 * stub the OpenCode install; the default is the real setupOpenCode.
 * Returns { label, branch, path, base, mainRoot, setup } or throws SessionRefusal.
 */
export function openSession({ target, name, setup = setupOpenCode, pluginRootDir = pluginRoot }) {
  const mainRoot = resolveMainCheckout(target);
  const label = name ?? nextDefaultLabel(mainRoot);
  checkLabel(label);
  const branch = `${BRANCH_PREFIX}${label}`;
  const path = worktreePathFor(mainRoot, label);
  if (existsSync(path) || registeredWorktrees(mainRoot).includes(path)) {
    throw new SessionRefusal(`REFUSED: the worktree ${path} already exists; pick another --name, or remove it first with --remove ${label}`);
  }
  if (branchExists(mainRoot, branch)) {
    throw new SessionRefusal(`REFUSED: the branch ${branch} already exists; pick another --name, or delete the branch (git branch -d ${branch}) if it is finished`);
  }
  const base = defaultBranch(mainRoot);
  mkdirSync(dirname(path), { recursive: true });
  gitOrThrow(mainRoot, ['worktree', 'add', '-b', branch, path, base]);

  // .sterling/config.json is gitignored, so the new worktree has none, and the OpenCode
  // agent set refuses to render without one (config.models pins each role's model).
  // A copy gives the bootstrap the main checkout's models, and exists only for the setup
  // call: a worktree holding config.json looks like its own Sterling root and the copy
  // goes stale, so it is removed afterwards, also when setup throws. The main checkout's
  // config stays the only one.
  const mainConfig = join(mainRoot, '.sterling', 'config.json');
  const worktreeConfig = join(path, '.sterling', 'config.json');
  let result;
  try {
    if (existsSync(mainConfig)) {
      mkdirSync(join(path, '.sterling'), { recursive: true });
      copyFileSync(mainConfig, worktreeConfig);
    }
    result = setup({ projectDir: path, pluginRoot: pluginRootDir });
  } finally {
    rmSync(worktreeConfig, { force: true });
  }
  return { label, branch, path, base, mainRoot, setup: result };
}

/** Remove a clean session worktree; keeps the branch when it holds unmerged commits. */
export function removeSession({ target, name }) {
  const mainRoot = resolveMainCheckout(target);
  checkLabel(name);
  const branch = `${BRANCH_PREFIX}${name}`;
  const path = worktreePathFor(mainRoot, name);
  if (!registeredWorktrees(mainRoot).includes(path)) {
    throw new SessionRefusal(`REFUSED: ${path} is not a worktree of ${mainRoot} (git worktree list shows no such path)`);
  }
  const dirty = git(path, ['status', '--porcelain']);
  if (dirty.status !== 0) throw new SessionRefusal(`REFUSED: git status failed in ${path} (${dirty.stderr}); not removing a worktree whose state is unknown`);
  if (dirty.stdout) {
    throw new SessionRefusal(`REFUSED: ${path} has uncommitted changes:\n${dirty.stdout}\ncommit or discard them (the session's work is not lost until you do), then rerun --remove ${name}`);
  }
  gitOrThrow(mainRoot, ['worktree', 'remove', path]);
  let branchKept = null;
  if (branchExists(mainRoot, branch)) {
    const del = git(mainRoot, ['branch', '-d', branch]);
    if (del.status !== 0) branchKept = del.stderr || del.stdout;
  }
  return { path, branch, branchKept };
}

function usage(msg) {
  console.error(`open-session: ${msg}\nusage: open-session.mjs [--target <project>] [--name <label>]\n       open-session.mjs [--target <project>] --remove <label>`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { target: process.cwd(), name: undefined, remove: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--target', '--name', '--remove'].includes(flag)) usage(`unrecognized argument '${flag}'`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage(`${flag} requires a value`);
    if (flag === '--target') opts.target = resolve(value);
    else if (flag === '--name') opts.name = value;
    else opts.remove = value;
  }
  if (opts.remove !== undefined && opts.name !== undefined) usage('--remove and --name cannot be combined');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.remove !== undefined) {
      const { path, branch, branchKept } = removeSession({ target: opts.target, name: opts.remove });
      console.log(`removed worktree: ${path}`);
      if (branchKept) console.log(`branch kept: ${branch} has commits not merged into the base (${branchKept}); delete it with git branch -D ${branch} once you no longer need them`);
      else console.log(`deleted branch: ${branch}`);
      return;
    }
    const { label, branch, path, base, mainRoot, setup } = openSession({ target: opts.target, name: opts.name });
    console.log(`created worktree: ${path}`);
    console.log(`branch: ${branch} (from ${base})`);
    for (const line of formatOpenCodeRows(setup)) console.log(line);
    const problems = setup.skipped ? [setup.skipped] : (setup.rows ?? []).filter((r) => r.refused).map((r) => r.instruction);
    if (problems.length) {
      for (const p of problems) console.error(`\n${p}\n`);
      console.error(`The worktree exists but OpenCode is NOT ready in it. Fix the above, then run --remove ${label} and open the session again.`);
      process.exit(2);
    }
    console.log(`\nStart the session in the worktree (never move an existing session into it):\n  cd "${path}" && opencode`);
    console.log('Parallel sessions share the main checkout\'s board: claim a board task before working on it, so another session does not take the same one.');
    console.log(`When the session is finished and its work is merged: node "${join(pluginRoot, 'bin', 'open-session.mjs')}" --target "${mainRoot}" --remove ${label}`);
  } catch (err) {
    if (!(err instanceof SessionRefusal)) throw err;
    console.error(err.message);
    process.exit(err.exit);
  }
}

// import.meta.url is rewritten to name this scripts/ source when bundled into bin/
// (source-location identity), so the guard accepts both launch paths, as move-store does.
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs === fileURLToPath(import.meta.url) || launchedAs === fileURLToPath(new URL('../bin/open-session.mjs', import.meta.url))) main();
