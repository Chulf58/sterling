// Consumer-machine update core [S] (decision foreign_e6240afe).
//
// WHY THIS EXISTS: Sterling is distributed as a clone of origin — no npm
// package, no marketplace entry, no release artifact — and nothing on a machine
// could answer "am I current?". The version strings never moved (0.1.0 since the
// first commit), so a stale machine could only be diagnosed by comparing its
// files against GitHub by hand. That spends judgment on a mechanical question
// (P3), and it is exactly how one machine's update became a file-by-file
// reconciliation.
//
// THE POSTURE: every machine but the authoring one is a PURE CONSUMER of the
// default branch. A consumer never authors, so an update is a FAST-FORWARD OR A
// REFUSAL — never a merge, never a rebase, never a hand comparison. Divergence
// is reported for a human to resolve on the authoring machine (P5); the refusals
// below mutate nothing, which is what makes running this unattended safe.
//
// The logic lives here as pure-ish functions over an injected `exec` so the
// refusal matrix and the step ordering are unit-testable without a network, an
// npm install, or a 90-second test battery. scripts/update.mjs is the thin CLI.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// builtins-only module — safe at load time on an unbuilt clone (see the
// bootstrap-independence note in scripts/update.mjs).
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from './update-launcher.mjs';
import { ensureConsumerCheckLauncher, CONSUMER_CHECK_LAUNCHER_NAME } from './consumer-checks.mjs';
import { readProjectMode, ProjectModeError, HOBBY_SKIP_DETAIL, HANDOFF_ROOT_FILES, isHandoffPath } from './handoff-projection.mjs';
import { ContainmentError, existsContained, readContained } from './contained-fs.mjs';
import { fileURLToPath } from 'node:url';

// Build + test batteries dominate an update (measured on this machine: build
// ~19s, check ~12s, tests ~87s), so the ceiling is generous — a timeout here
// would abort a healthy update, which is worse than waiting.
const STEP_TIMEOUT_MS = 900_000;

/** Real command runner. Never throws — every caller inspects `status` (P5: no silent path). */
export function defaultExec(cmd, args, { cwd, timeout = STEP_TIMEOUT_MS } = {}) {
  // npm resolves through a .cmd shim on native Windows, which spawn cannot exec
  // directly; the revived native launcher (decision foreign_a756e5d9) means this script
  // runs there too. Shell mode does no quoting of its own, so quote here —
  // project paths on this box genuinely contain spaces.
  const shell = process.platform === 'win32';
  const q = (s) => (shell && /[\s"]/.test(s) ? `"${s}"` : s);
  const r = spawnSync(q(cmd), args.map(q), { cwd, encoding: 'utf8', timeout, shell });
  return {
    status: r.error ? 1 : (r.status ?? 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  };
}

/** git wrapper over an injected exec: trimmed stdout, or '' when allowFail and git errored. */
export function gitFrom(exec, cwd) {
  return (args, { allowFail = false } = {}) => {
    const r = exec('git', args, { cwd });
    if (r.status !== 0) {
      if (allowFail) return '';
      throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
    }
    return (r.stdout ?? '').trim();
  };
}

/**
 * Everything the refusal matrix and the currency report need, in one read.
 * Reads only — safe to call before deciding anything.
 */
export function readCurrency({ git }) {
  if (git(['rev-parse', '--git-dir'], { allowFail: true }) === '') return { is_repo: false };

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  const detached = branch === 'HEAD' || branch === '';
  const head = git(['rev-parse', 'HEAD'], { allowFail: true });
  // --always so a repo with no tags still describes (the SHA); tags are the
  // OPTIONAL human-legible layer, never a precondition.
  const describe = git(['describe', '--tags', '--always'], { allowFail: true });
  const has_origin = git(['remote'], { allowFail: true }).split('\n').filter(Boolean).includes('origin');
  // origin/HEAD is the authority on the default branch; main is the fallback for
  // clones that never fetched it (git clone sets it, `git init` + remote add does not).
  const default_branch = has_origin
    ? git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }).replace(/^origin\//, '') || 'main'
    : null;
  const upstream = !detached && has_origin ? `origin/${branch}` : null;
  const upstream_exists = !!upstream && git(['rev-parse', '--verify', '--quiet', upstream], { allowFail: true }) !== '';

  let behind = 0;
  let ahead = 0;
  if (upstream_exists) {
    const [b, a] = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { allowFail: true })
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  const lines = git(['status', '--porcelain'], { allowFail: true }).split('\n').filter(Boolean);
  return {
    is_repo: true,
    branch,
    detached,
    head,
    head_short: head.slice(0, 7),
    describe,
    has_origin,
    default_branch,
    upstream,
    upstream_exists,
    behind,
    ahead,
    // TRACKED changes block; untracked never do. The six machine-specific
    // artifacts init generates are gitignored (so absent from --porcelain
    // entirely) and must survive an update untouched.
    dirty_tracked: lines.filter((l) => !l.startsWith('??')),
    untracked: lines.filter((l) => l.startsWith('??')),
  };
}

// Tracked files that are GENERATED, not authored source. TWO FAMILIES, both
// regenerated by their producer, neither ever hand-edited or pushed FROM a
// consumer: (1) the hooks/*.mjs bundles, committed so git protects the
// enforcement logic (decision foreign_2422e76a) — hooks/hooks.json is NOT here, it is a
// hand-maintained registry; (2) the store PROJECTIONS architecture.md and
// rulings.md — the same pair .sterling/config.json lists under
// generated_projections and scripts/check-projection-fresh.mjs freshness-checks.
// rulings.md was missing from this list from the day it was added (board
// 778226f0), so a dirty one drew the "push from the authoring machine" remedy
// that can never be right for a projection.
//
// packages/tui/bundle/sterling-tui.mjs is deliberately ABSENT. It is gitignored
// (.gitignore: packages/tui/bundle/), so it never appears in `git status
// --porcelain` at all — listing it would be inert, not protective. This list
// does not decide WHICH files are at stake (git does, above); it only decides
// which REMEDY a refusal prints for a file git already reported.
const GENERATED_TRACKED = [/^hooks\/[^/]+\.mjs$/, /^architecture\.md$/, /^rulings\.md$/];

/** Path from a `git status --porcelain` line, resolving a rename to its DESTINATION. */
function porcelainPath(line) {
  const raw = line.slice(3).trim();
  const arrow = raw.lastIndexOf(' -> ');
  return (arrow === -1 ? raw : raw.slice(arrow + 4)).replace(/^"|"$/g, '');
}

function isGeneratedTracked(line) {
  const p = porcelainPath(line);
  return GENERATED_TRACKED.some((re) => re.test(p));
}

function generatedPaths(lines) {
  return [...new Set(lines.map(porcelainPath))];
}

// SHELL-QUOTE PATHS PRINTED IN A COPY-PASTE REMEDY (review finding, MEDIUM).
// GENERATED_TRACKED's anchored regexes (`[^/]+` before the extension) admit
// spaces and shell metacharacters same as any other filename character — they
// only forbid an extra path separator. This script itself never executes
// these commands (it only prints advice), but a bare, unquoted path is worse
// than useless: on a consumer machine, `git checkout -- ` or `git restore
// --staged --worktree -- ` followed by a filename containing a space splits
// into multiple pathspecs, and a filename containing `;`/`` ` ``/`$(...)`
// copy-pasted into a shell runs as an EXTRA command.
//
// QUOTE ONLY WHEN NEEDED: a path built only from letters/digits/`. _ / -` is
// printed bare, unchanged from before this fix — that keeps every existing
// ordinary-filename remedy byte-identical (frozen pins in update.test.mjs
// match the unquoted form for plain paths like architecture.md). Anything
// else is single-quoted with the standard POSIX embedded-quote escape, which
// is safe across the shells this advice is realistically pasted into (POSIX
// sh/bash/zsh and git-bash on Windows).
function shellQuote(path) {
  if (/^[A-Za-z0-9._/-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The refusal matrix: a string to print and stop on, or null to proceed.
 * Every message names the defect AND where it gets fixed — a consumer machine
 * has nothing to adjudicate, so it must never be left guessing.
 */
export function refusalFor(c) {
  if (!c.is_repo) {
    return 'update: not a git repository — Sterling is distributed as a clone of origin, so there is nothing to fast-forward here. Re-clone the repo rather than copying files between machines.';
  }
  if (!c.has_origin) {
    return "update: no 'origin' remote — this working copy has no upstream to consume. Add origin (git remote add origin <url>) or re-clone.";
  }
  if (c.detached) {
    return `update: HEAD is detached at ${c.head_short} — a consumer machine tracks a branch. Run: git checkout ${c.default_branch ?? 'main'}`;
  }
  if (c.default_branch && c.branch !== c.default_branch) {
    return `update: on branch '${c.branch}', not '${c.default_branch}'. A consumer machine tracks the default branch; branch work belongs on the authoring machine. Run: git checkout ${c.default_branch}  (and push '${c.branch}' first if it holds work).`;
  }
  if (!c.upstream_exists) {
    return `update: no upstream ref '${c.upstream}' — fetch has never seen it. Run: git fetch origin`;
  }
  if (c.dirty_tracked.length) {
    // Split by WHAT the file is, because the remedy differs and one message gave
    // the wrong one for half of them (reported from a consumer 2026-07-30: a
    // dirty hooks/ bundle was met with "commit and push from the authoring
    // machine", which is never right for a build output the consumer is
    // explicitly told not to rebuild — see the build step's own comment below).
    const generated = c.dirty_tracked.filter(isGeneratedTracked);
    const source = c.dirty_tracked.filter((l) => !isGeneratedTracked(l));
    const listed = (ls) => ls.map((l) => `  ${l}`).join('\n');
    const parts = ['update: uncommitted changes to tracked files — nothing was mutated.'];
    if (generated.length) {
      parts.push(
        'COMMITTED BUILD OUTPUTS — discard these, always. They are tracked only so git protects them; none of them is authored on a consumer, and none is ever pushed from one. TWO FAMILIES, discardable for different reasons:\n' +
          '  · hooks/*.mjs are esbuild bundles the update deliberately does NOT rebuild. A local rebuild here is not work worth keeping, and discarding cannot hide a defect: `npm run check` rebuilds every hook source into a temp dir and byte-compares it against the committed bundle, so a genuinely wrong bundle fails at the check step instead.\n' +
          '  · architecture.md and rulings.md are read-only PROJECTIONS of the knowledge store, regenerated by scripts/architecture-projection.mjs / scripts/rulings-projection.mjs. A consumer clone has no store to project from, so a local modification there is drift, never work — and its freshness is checked where the store lives, not here.\n' +
          `  Run: git checkout -- ${generatedPaths(generated).map(shellQuote).join(' ')}\n` +
          `  …or, if any of them is STAGED: git restore --staged --worktree -- ${generatedPaths(generated).map(shellQuote).join(' ')}\n` +
          '  (`git checkout --` restores the worktree from the INDEX, so a staged generated change survives it; the porcelain lines below carry the staged status in their first column.)\n' +
          listed(generated)
      );
    }
    if (source.length) {
      parts.push(
        'SOURCE CHANGES — a consumer machine has nothing to merge, so this is either accidental drift or work that belongs on the authoring machine. Discard (git checkout -- .) or commit and push from the authoring machine:\n' +
          listed(source)
      );
    }
    parts.push('Then rerun.');
    return parts.join('\n');
  }
  if (c.ahead > 0) {
    return c.behind > 0
      ? `update: DIVERGED — ${c.ahead} local commit(s) not on ${c.upstream}, and ${c.behind} upstream commit(s) not here. A consumer machine never authors, so this is not fast-forwardable. Push '${c.branch}' as its own branch from here, or discard the local commits (git reset --hard ${c.upstream}), then rerun.`
      : `update: ${c.ahead} local commit(s) ahead of ${c.upstream} — this machine has authored. Push them as a branch, or discard them (git reset --hard ${c.upstream}), then rerun. Consumer machines track the default branch and never commit to it.`;
  }
  return null;
}

/**
 * Stamp machine_role:'consumer' into <cwd>/.sterling/config.json, but ONLY
 * when the field is ABSENT (todo cabbc10f, decision foreign_a9b98b7d). Never
 * overwrites a declared role — this is what makes "the authoring machine
 * sometimes pulls" harmless: it declares 'authoring' once, by hand, and no
 * update can flip it back. Read-modify-write so every other field survives
 * byte-for-practical-purposes (parse, set one key, re-stringify) — no schema
 * import here, deliberately: a consumer stamping its own config must not
 * refuse on a field this build's schema does not yet know about.
 *
 * LOUD but NONFATAL (P5): the update itself already succeeded by the time
 * this runs, so any failure here is a warning via `log`, never a thrown
 * error that would make a successful update look failed.
 */
export function stampConsumerRoleIfAbsent(cwd, log) {
  const configPath = join(cwd, '.sterling', 'config.json');
  if (!existsSync(configPath)) {
    // The guidance, not the gate: this function must never CREATE the config (a
    // machine-role-only config would be a schema-shaped file nothing else wrote), and
    // "run /sterling:init here first" was the wrong instruction — since board 2a6b45c2
    // nothing requires the clone to be init'd as a project, so a clone with no config
    // is the normal consumer shape. H1 then reports the role as UNDECLARED, which it
    // already documents as "treat as CONSUMER" — the safe posture, not a gap.
    log(
      '\n▸ machine-role stamp — SKIPPED: no .sterling/config.json in the clone. Normal for a consumer machine (the clone is not init\'d as a project). H1 reports MACHINE ROLE: UNDECLARED, which is treated as CONSUMER — declare machine_role explicitly only on the authoring machine.',
    );
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(parsed, 'machine_role')) {
      log(`\n▸ machine-role stamp — already '${parsed.machine_role}', not overwritten`);
      return;
    }
    parsed.machine_role = 'consumer';
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
    log("\n▸ machine-role stamp — machine_role was absent, stamped 'consumer'");
  } catch (err) {
    log(`\n⚠ machine-role stamp FAILED (nonfatal — the update itself already succeeded): ${err?.message ?? err}`);
  }
}

/** The one-line currency answer: what this machine is on, and how far behind. */
export function currencyLine(c) {
  const id = c.describe && c.describe !== c.head_short ? `${c.describe} (${c.head_short})` : c.head_short;
  const gap =
    c.behind === 0 && c.ahead === 0
      ? 'up to date'
      : [c.behind ? `${c.behind} behind` : null, c.ahead ? `${c.ahead} ahead` : null].filter(Boolean).join(', ');
  return `sterling: ${id} on ${c.branch} · ${c.upstream ?? 'no upstream'} · ${gap}`;
}

// The on-disk proof that a PREVIOUS run's post-merge sequence (build through
// agent sync, :495-634) finished IN FULL, not merely that git itself is
// current. Board 2b37272a claim A: the ff-merge runs BEFORE build/check/test/
// sync, so a run that halts anywhere in that sequence has already advanced
// HEAD — the next run then sees `behind === 0` from git alone and cannot tell
// a halted run from a fully-synced one. This marker closes that gap. Under
// `.sterling/` deliberately (invariant 5 seals only sterling.db; every other
// file there, .gitignore already covers the whole directory).
export const UPDATE_MARKER_RELATIVE_PATH = join('.sterling', 'update-complete.json');

/**
 * The sha a prior COMPLETE run left behind, or null when there is nothing to
 * trust. Absent is the ordinary first-run/never-completed shape and stays
 * silent; present-but-corrupt is a DEGRADATION and must announce itself
 * (P5) — both return null so the caller resumes either way, but only the
 * corrupt case logs.
 */
// Also carries `handoff_retry`: the project paths whose handoff projection ended
// in an ACTIONABLE refusal (exit 3). That is per-project retry state, not a
// failure of the clone update: one project that can never be repaired must not
// keep the whole sequence from completing (Sol re-check, the update wedge).
function readUpdateMarker(cwd, log) {
  const p = join(cwd, UPDATE_MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed?.sha !== 'string' || !parsed.sha) throw new Error('missing or invalid "sha" field');
    const retry = parsed.handoff_retry ?? [];
    if (!Array.isArray(retry) || retry.some((r) => typeof r !== 'string')) throw new Error('invalid "handoff_retry" field');
    const projects = parsed.projects ?? {};
    const isState = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.mode === 'string';
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects) || !Object.values(projects).every(isState)) {
      throw new Error('invalid "projects" field');
    }
    const projectRetry = parsed.project_retry ?? [];
    if (!Array.isArray(projectRetry) || projectRetry.some((r) => typeof r !== 'string')) throw new Error('invalid "project_retry" field');
    return { sha: parsed.sha, handoff_retry: retry, projects, project_retry: projectRetry };
  } catch (err) {
    log(`\n⚠ update marker '${p}' is corrupt/unreadable — degrading to a full resume rather than trusting a marker that cannot be verified: ${err?.message ?? err}`);
    return null;
  }
}

/** Written ONLY once runUpdate reaches its clean end with report.exit === 0 —
 *  see the call site. A halted or failed run must never leave a marker that
 *  makes the NEXT run believe "Already current" without the sequence having
 *  actually finished. */
// `projects` is the per-project PROVISIONING STATE (decision
// project-mode-hobby-work-toggle-decides-flow; Sol review of S1): repo_path →
// { mode: 'hobby' } for a project last seen in hobby mode, or { mode: 'work',
// head, outcome } for the last successful work provisioning (agent sync plus
// projection) at clone sha `head`. The already-current path reads it to decide
// which work projects need provisioning; presence of files alone never decides.
// `project_retry` (Sol review of S1, item 3): projects whose config.mode is
// invalid. Unlike handoff_retry it reruns BOTH the agent sync and the
// projection once the mode is fixed; update exits non-zero while it is non-empty.
function writeUpdateMarker(cwd, sha, handoffRetry = [], projects = {}, projectRetry = []) {
  const p = join(cwd, UPDATE_MARKER_RELATIVE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ sha, completed_at: new Date().toISOString(), handoff_retry: handoffRetry, project_retry: projectRetry, projects }, null, 2) + '\n');
}

// The project's config bytes, hashed: a STANDING refusal (outcome 'standing')
// is retried only when this or the clone head changes. Read through contained-fs.
function configHash(repoPath) {
  const rel = '.sterling/config.json';
  return existsContained(repoPath, rel, 'file') ? createHash('sha256').update(readContained(repoPath, rel)).digest('hex') : 'absent';
}

// The clone this module lives in: its registry declares the portable set.
const MODULE_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A work project's files are complete when EVERY portable agent the registry
// declares, both handoff indexes, and every docs/sterling file registered in its
// config.generated_projections exist as regular files — checked exactly, never
// "some .md". Target paths go through contained-fs (a symlink or non-directory
// on the way throws ContainmentError).
function workFilesComplete(repoPath) {
  const registry = JSON.parse(readFileSync(join(MODULE_PLUGIN_ROOT, 'agent-templates', 'registry.json'), 'utf8'));
  const portable = registry.agents.filter((a) => a.opencode !== undefined).map((a) => `.opencode/agents/${a.name}.md`);
  const config = existsContained(repoPath, '.sterling/config.json', 'file') ? JSON.parse(readContained(repoPath, '.sterling/config.json')) : {};
  const registered = Array.isArray(config.generated_projections) ? config.generated_projections.filter((r) => typeof r === 'string' && isHandoffPath(r)) : [];
  return [...portable, ...HANDOFF_ROOT_FILES, ...registered].every((rel) => existsContained(repoPath, rel, 'file'));
}

// What to do about a project whose handoff refusal will not go away by itself.
export function handoffRetryRemedy(repoPath) {
  return (
    `fix it in ${repoPath} and rerun /sterling:update (only this project is retried). ` +
    `If it cannot be repaired: retire it (move or delete the project, then \`node scripts/list-projects.mjs --prune-missing\` unregisters it), ` +
    `or set "store_authority": "secondary" in its .sterling/config.json so the refusal becomes a standing one.`
  );
}

/** Existing project + domain stores, without opening any database connection. */
function machineStores(cwd) {
  const stores = [join(cwd, '.sterling', 'sterling.db')];
  const domains = join(homedir(), '.sterling', 'domains');
  if (existsSync(domains)) {
    for (const name of readdirSync(domains).sort()) {
      stores.push(join(domains, name, 'sterling.db'));
    }
  }
  return stores.filter((store) => existsSync(store));
}

/** SQLite's application-owned user_version is the big-endian u32 at header offset 60. */
function probeSchemaVersion(dbPath) {
  const fd = openSync(dbPath, 'r');
  const header = Buffer.alloc(100);
  let bytesRead;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (bytesRead < header.length || header.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    throw new Error(`'${dbPath}' is not a valid SQLite database file`);
  }
  return header.readUInt32BE(60);
}

/**
 * The update sequence. Returns { exit, currency, steps, projects, refusal }.
 * exit: 0 ok · 1 a step failed · 2 refused (nothing mutated) or an agent sync refusal.
 *
 * `projects` is an array OR a (possibly async) function returning one. The
 * function form is not a convenience: the CLI cannot read the project registry
 * until the workspace packages are BUILT, and building them is a step in here —
 * so on a fresh clone the fan-out list must be resolved LATE, at its own step,
 * not at startup.
 */
export async function runUpdate({ cwd, exec = defaultExec, log = console.log, projects = [], opts = {} }) {
  const git = gitFrom(exec, cwd);
  const nodeBin = opts.nodeBin ?? process.execPath;
  const report = { exit: 0, currency: null, steps: [], projects: [], migrations: [], refusal: null, handoff_retry: [], project_retry: [] };
  // A project whose config.mode is invalid (or unreadable through contained-fs):
  // its own refusal class, logged with its own message, joining project_retry.
  // Returns the mode, or null after reporting the refusal.
  const projectModeOrRefuse = (p, indent = '  ') => {
    try {
      return readProjectMode(p.repo_path);
    } catch (err) {
      if (!(err instanceof ProjectModeError) && !(err instanceof ContainmentError)) throw err;
      log(`${indent}✗ ${p.name}: REFUSED — project mode: ${err.message}. Nothing was synced or projected for this project; the next /sterling:update reruns its agent sync and handoff projection once config.mode is fixed.`);
      if (!report.project_retry.includes(p.repo_path)) report.project_retry.push(p.repo_path);
      return null;
    }
  };
  // Per-project provisioning state persisted in the completion marker (see
  // writeUpdateMarker). Seeded from the marker on the already-current path; the
  // full fan-out rebuilds it for every project it visits.
  let provisioning = {};
  // outcome 'ok': agent sync and projection both succeeded. outcome 'standing':
  // the agents synced but the projection refused STANDING (exit 2, e.g. a
  // secondary store) — nothing to retry until the config or the head changes,
  // so `config` records the config hash it was judged against.
  const recordProvisioning = (p, head, syncStatus, handoffStatus) => {
    if (handoffStatus === 'skipped') {
      provisioning[p.repo_path] = { mode: 'hobby' };
      return;
    }
    const outcome = syncStatus === 0 && handoffStatus === 0 ? 'ok' : syncStatus === 0 && handoffStatus === 2 ? 'standing' : null;
    if (!outcome) {
      delete provisioning[p.repo_path];
      return;
    }
    try {
      provisioning[p.repo_path] = { mode: 'work', head, outcome, config: configHash(p.repo_path) };
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      delete provisioning[p.repo_path]; // unprovable: the next run judges it afresh
    }
  };

  // Handoff projection for one project (decision
  // init-prepares-opencode-portable-agents-and-target-handoff-projections): refresh
  // its committed architecture.md / rulings.md / docs/sterling/ from ITS OWN store.
  // Exit 2 is a STANDING refusal (a secondary store): loud, never fatal. Exit 3 is
  // an ACTIONABLE refusal (a hand-written file, symlink or ignore rule in the way, a
  // missing or empty store): the project joins report.handoff_retry, which the
  // completion marker persists, and the next already-current run retries ONLY it.
  // Any other failure (exit 1) may have left an INCOMPLETE export: update exit 1.
  // Project mode (decision project-mode-hobby-work-toggle-decides-flow): the
  // projection is WORK-ONLY, read from the project's OWN config. Hobby is a loud
  // skip (returns 'skipped', deletes nothing, never enters the retry set); an
  // invalid mode is an actionable refusal that joins the retry set like exit 3.
  const runHandoff = (p) => {
    const mode = projectModeOrRefuse(p, '      ');
    if (mode === null) return 'refused_project_mode';
    if (mode !== 'work') {
      log(`      skipped — ${HOBBY_SKIP_DETAIL}`);
      return 'skipped';
    }
    const handoff = exec(nodeBin, [join(cwd, 'scripts', 'handoff-projection.mjs'), p.repo_path], { cwd });
    const handoffOut = `${handoff.stdout}${handoff.stderr}`.trim();
    const handoffLine = handoffOut.split('\n')[0];
    if (handoff.status === 2) {
      log(`      ⚠ ${handoffLine}`);
    } else if (handoff.status === 3) {
      log(`      ✗ ${handoffLine}\n        (${handoffRetryRemedy(p.repo_path)})`);
      report.handoff_retry.push(p.repo_path);
    } else if (handoff.status !== 0) {
      log(`      ✗ handoff projection FAILED (exit ${handoff.status}) — the export may be INCOMPLETE:\n${handoffOut.split('\n').map((l) => `          ${l}`).join('\n')}`);
      report.exit = report.exit === 0 ? 1 : report.exit;
    } else if (!handoffLine.startsWith('handoff projection: unchanged')) {
      log(`      ${handoffLine}`);
    }
    return handoff.status;
  };

  // A step: loud on failure (full output), one line on success. A failure stops
  // the sequence — half-updating quietly is the failure mode this replaces.
  const step = (label, cmd, args, { cwd: stepCwd = cwd, tolerate = false, show = false } = {}) => {
    log(`\n▸ ${label}`);
    const r = exec(cmd, args, { cwd: stepCwd });
    const out = `${r.stdout}${r.stderr}`.trim();
    report.steps.push({ label, cmd: `${cmd} ${args.join(' ')}`, status: r.status });
    if (r.status !== 0) {
      log(out || '(no output)');
      if (!tolerate) {
        log(`\n✗ ${label} FAILED (exit ${r.status}) — stopping. The fast-forward stands; fix the failure and rerun.`);
        report.exit = 1;
      } else {
        log(`  (non-fatal — continuing)`);
      }
      return { ok: r.status === 0, out };
    }
    if (show && out) log(out);
    else log('  ok');
    return { ok: true, out };
  };

  if (opts.fetch !== false) {
    const f = exec('git', ['fetch', 'origin', '--tags', '--prune'], { cwd });
    if (f.status !== 0) {
      report.refusal = `update: git fetch failed — cannot establish what current is:\n${(f.stderr || f.stdout || '').trim()}`;
      log(report.refusal);
      report.exit = 1;
      return report;
    }
  }

  const before = readCurrency({ git });
  report.currency = before;

  const refusal = refusalFor(before);
  if (refusal) {
    report.refusal = refusal;
    log(refusal);
    report.exit = 2;
    return report;
  }

  log(currencyLine(before));
  if (before.untracked.length) {
    log(`  (${before.untracked.length} untracked file(s) present — not touched, not blocking)`);
  }

  if (opts.check) {
    log(
      before.behind === 0
        ? '\nThis machine is current. Nothing to do.'
        : `\n${before.behind} commit(s) behind — run /sterling:update to apply:\n` +
            git(['log', '--oneline', '--no-decorate', `HEAD..${before.upstream}`], { allowFail: true })
              .split('\n')
              .filter(Boolean)
              .map((l) => `  ${l}`)
              .join('\n')
    );
    return report;
  }

  // REGISTRY COVERAGE (board 6ce18724, research_finding foreign_0038af7c): the agent
  // fan-out reports what it synced and CANNOT report what it does not know
  // about — a project carrying Sterling agents but ABSENT from the shared
  // registry is never visited, so its agents freeze at install date while this
  // clone updates perfectly (measured 2026-08-28: two such projects, 43 and 80
  // days). Scan the roots that already hold known projects and NAME the gaps.
  //
  // A CLOSURE, called from BOTH the already-current path and the full path, for
  // the same reason the sibling-config sweep above became one (board 52c1d504):
  // the state this exists to expose — a machine whose clone is CURRENT while two
  // of its projects are invisible to the registry — is precisely the state that
  // takes the early `return`, so a report sitting only on the fast-forward path
  // would never run on the machine that needs it. One call site, two callers.
  //
  // A REPORT, NEVER AN ACTION: nothing is registered, synced or written here
  // (registry self-heal was ruled OUT for this build, user 2026-08-29), and
  // nothing here can change report.exit.
  const reportCoverage = async (list) => {
    if (opts.projects === false) return;
    try {
      // Imported DYNAMICALLY on purpose: this module is builtins-only at load
      // time (it must load on a clone where nothing is built), while
      // agent-coverage.mjs reaches @sterling/schemas through
      // agent-distribution.mjs.
      const { scanAgentCoverage, dedupeRoots } = await import('./agent-coverage.mjs');
      // THE KNOWN ROOTS are the directories that already contain projects
      // Sterling knows about: every registered project's parent, plus the
      // clone's own. The clone itself counts as REGISTERED — the CLI
      // deliberately drops it from the fan-out list (its agents are synced by
      // the init ensure pass), so it is not a blind spot. Deduped by NORMALIZED
      // identity, not raw string: two legal spellings of one directory would
      // otherwise be walked twice and every finding listed twice.
      const roots = dedupeRoots([dirname(cwd), ...list.map((p) => dirname(p.repo_path))]);
      const coverage = scanAgentCoverage({
        roots,
        registeredProjects: [cwd, ...list.map((p) => p.repo_path)],
      });
      report.coverage = coverage;
      log(`\n▸ registry coverage — inspected ${coverage.scanned} candidate project director(y|ies) holding .claude/agents/ under ${roots.length} known root(s)`);
      for (const u of coverage.unreadable_roots) {
        log(`  ⚠ could not read the known root '${u.root}' — NO project under it was inspected (${u.error})`);
      }
      for (const u of coverage.unreadable_projects) {
        log(`  ⚠ could not fully inspect '${u.path}' — that ONE project's coverage is UNKNOWN; every other project was still inspected (${u.error})`);
      }
      const incomplete = coverage.unreadable_roots.length + coverage.unreadable_projects.length;
      if (coverage.unregistered.length) {
        log(
          `  ⚠ ${coverage.unregistered.length} project(s) carry Sterling agents but are NOT in the shared project registry, so the agent sync never visits them — their agents are frozen at install date:\n` +
            coverage.unregistered.map((u) => `      ${u.path} (${u.agents.join(', ')})`).join('\n') +
            `\n    Register each by running /sterling:init in that project, or refresh one now:` +
            `\n      node ${join(cwd, 'scripts', 'sync-agents.mjs')} --target <path>   (then restart Claude Code there — subagents load at session start)`
        );
      } else if (incomplete) {
        // AN AFFIRMATIVE "ok" IS UNREACHABLE AFTER A PARTIAL SCAN (02a1ed39 at
        // the REPORT layer): "0 unregistered" out of a walk that could not read
        // part of what it was asked to read is not a clean bill of health, and
        // printing one is the same lie as nine consecutive `up_to_date`.
        log(`  ⚠ PARTIAL — nothing unregistered was found in what could be read, but ${incomplete} item(s) above could NOT be inspected, so coverage under these known roots is UNKNOWN, not clean`);
      } else {
        log('  ok — under these known roots, every project with installed Sterling agents is registered (a project under a root that no registered project shares is outside this scan by design)');
      }
    } catch (err) {
      // LOUD BUT NONFATAL, the same contract as the stamps above: the update
      // itself has already succeeded, so a coverage REPORT must never make it
      // look failed. Never silent — an unreported blind spot is the defect
      // this whole scan exists to close.
      log(`\n⚠ registry coverage scan FAILED (nonfatal — the update itself already succeeded): ${err?.message ?? err}`);
    }
  };

  if (before.behind === 0 && !opts.force) {
    const marker = readUpdateMarker(cwd, log);
    const markerSha = marker?.sha ?? null;
    provisioning = { ...(marker?.projects ?? {}) };
    if (markerSha === before.head) {
      // The clone update itself is complete. Unresolved projects are retried
      // FIRST (handoff_retry reruns the projection, project_retry — an invalid
      // mode — reruns the agent sync AND the projection), then the normal scan
      // below covers every registered project that was NOT retried, so a stuck
      // project never starves another one's provisioning (Sol re-check). One
      // marker write at the end.
      const hasRetry = (marker.handoff_retry.length || marker.project_retry.length) && opts.projects !== false;
      let noopProjectList = [];
      try {
        noopProjectList =
          opts.projects === false ? [] : (typeof projects === 'function' ? (await projects()) ?? [] : projects);
      } catch (err) {
        if (hasRetry) {
          log(`\n⚠ handoff retry skipped — project registry unavailable: ${err?.message ?? err}`);
          report.exit = 2;
          return report;
        }
        // FULLY NONFATAL without a retry set: an already-current update has
        // already succeeded, so a registry failure must NOT reject it.
        log(`\n⚠ registry coverage skipped — project registry unavailable (nonfatal): ${err?.message ?? err}`);
      }
      try {
        // The blind spot this reports is INDEPENDENT of clone lag — an
        // already-current clone with two unregistered projects is the measured
        // 2026-08-28 state exactly — so the report belongs on this path too.
        await reportCoverage(noopProjectList);
      } catch (err) {
        log(`\n⚠ registry coverage skipped (nonfatal): ${err?.message ?? err}`);
      }
      const recordedBefore = JSON.stringify(provisioning);
      const retriedPaths = new Set();
      if (hasRetry) {
        const byPath = new Map(noopProjectList.map((p) => [p.repo_path, p]));
        const retried = (repoPath) => {
          retriedPaths.add(repoPath);
          const p = byPath.get(repoPath);
          if (!p) log(`  • ${repoPath}: no longer registered — dropped from the retry set`);
          return p;
        };
        if (marker.project_retry.length) {
          log(`\n▸ already current at ${before.head_short}; retrying the agent sync and handoff projection for ${marker.project_retry.length} project(s) whose project mode was invalid`);
          for (const repoPath of marker.project_retry) {
            const p = retried(repoPath);
            if (!p || projectModeOrRefuse(p) === null) continue;
            const r = exec(nodeBin, [join(cwd, 'scripts', 'sync-agents.mjs'), '--target', p.repo_path], { cwd });
            if (r.status !== 0) {
              log(`  ✗ ${p.name}: agent sync ${r.status === 2 ? 'REFUSED' : 'failed'} (exit ${r.status}):\n${`${r.stdout}${r.stderr}`.trim().split('\n').map((l) => `      ${l}`).join('\n')}`);
              report.exit = r.status === 2 ? 2 : report.exit === 0 ? 1 : report.exit;
            } else {
              log(`  • ${p.name}: agents synced`);
            }
            const handoff = runHandoff(p);
            recordProvisioning(p, markerSha, r.status, handoff);
            report.projects.push({ name: p.name, repo_path: p.repo_path, status: r.status, handoff });
          }
        }
        if (marker.handoff_retry.length) {
          log(`\n▸ already current at ${before.head_short}; retrying the handoff projection for ${marker.handoff_retry.length} project(s) left unresolved by the last update`);
          for (const repoPath of marker.handoff_retry) {
            if (retriedPaths.has(repoPath)) continue; // already rerun in full above
            const p = retried(repoPath);
            if (!p) continue;
            log(`  • ${p.name}:`);
            const handoff = runHandoff(p);
            recordProvisioning(p, markerSha, 0, handoff);
            report.projects.push({ name: p.name, repo_path: p.repo_path, handoff });
          }
        }
      }
      // Hobby→work with HEAD unchanged (decision
      // project-mode-hobby-work-toggle-decides-flow; Sol review of S1): no new
      // commit will ever trigger the fan-out for a project switched to work, and
      // files present on disk prove nothing about their currency. A work project
      // is provisioned (idempotent agent sync + projection) when its recorded
      // state is missing, is not work, or is at another head — or when its file
      // set is incomplete. A hobby project's state is recorded as hobby, so a
      // later switch back to work re-provisions it.
      const toProvision = [];
      for (const p of noopProjectList) {
        if (retriedPaths.has(p.repo_path)) continue;
        const mode = projectModeOrRefuse(p, '\n');
        if (mode === null) {
          delete provisioning[p.repo_path];
          report.exit = 2;
          continue;
        }
        if (mode !== 'work') {
          provisioning[p.repo_path] = { mode: 'hobby' };
          continue;
        }
        const state = provisioning[p.repo_path];
        if (!state || state.mode !== 'work' || state.head !== before.head) {
          toProvision.push(p);
          continue;
        }
        // The probes read target paths through contained-fs: a symlink or a
        // non-directory on the way is a REPORTED refusal, never a throw out of
        // the update and never a provisioning through the unsafe path.
        try {
          const stale = state.outcome === 'standing' ? configHash(p.repo_path) !== state.config : !workFilesComplete(p.repo_path);
          if (stale) toProvision.push(p);
        } catch (err) {
          if (!(err instanceof ContainmentError)) throw err;
          log(`\n✗ ${p.name}: REFUSED — ${err.message}; its OpenCode and handoff files were not checked or provisioned (fix the path, then rerun /sterling:update)`);
          report.exit = 2;
        }
      }
      if (toProvision.length) {
        log(`\n▸ already current at ${before.head_short}; provisioning ${toProvision.length} work-mode project(s) whose OpenCode or handoff files are unrecorded, stale or incomplete`);
        for (const p of toProvision) {
          const r = exec(nodeBin, [join(cwd, 'scripts', 'sync-agents.mjs'), '--target', p.repo_path], { cwd });
          const out = `${r.stdout}${r.stderr}`.trim();
          if (r.status !== 0) {
            log(`  ✗ ${p.name}: agent sync ${r.status === 2 ? 'REFUSED' : 'failed'} (exit ${r.status}):\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
            report.exit = r.status === 2 ? 2 : report.exit === 0 ? 1 : report.exit;
          } else {
            log(`  • ${p.name}: agents synced`);
          }
          const handoff = runHandoff(p);
          recordProvisioning(p, before.head, r.status, handoff);
          report.projects.push({ name: p.name, repo_path: p.repo_path, status: r.status, handoff });
        }
      }
      const unresolved = report.handoff_retry.length || report.project_retry.length;
      if (hasRetry || toProvision.length || unresolved || JSON.stringify(provisioning) !== recordedBefore) {
        try {
          writeUpdateMarker(cwd, markerSha, report.handoff_retry, provisioning, report.project_retry);
        } catch (err) {
          log(`\n⚠ update marker write FAILED: ${err?.message ?? err}`);
          report.exit = report.exit === 0 ? 1 : report.exit;
        }
      }
      if (unresolved) report.exit = report.exit === 0 ? 2 : report.exit;
      else if (hasRetry) log('\nEvery previously unresolved project is now resolved.');
      if (report.exit === 0 && !hasRetry && !toProvision.length) log('\nAlready current — nothing to do. (Rerun with --force to rebuild and re-sync anyway.)');
      return report;
    }
    // Git is current, but nothing on disk proves the LAST post-merge sequence
    // (build through agent sync, below) ever finished at this sha — a halted
    // run already advanced HEAD before failing (board 2b37272a claim A), so
    // "behind === 0" alone can never mean "fully synced". Resume the sequence
    // — from here straight into the build step below — instead of reporting
    // done; a halt could have happened anywhere in it.
    log(
      markerSha
        ? `\n▸ git is current at ${before.head_short}, but the last completed-update marker points elsewhere (${markerSha.slice(0, 7)}) — a previous run may have halted partway through. Resuming the full post-merge sequence (build onward) instead of reporting "Already current".`
        : `\n▸ git is current at ${before.head_short}, but no completed-update marker was found — resuming the full post-merge sequence (build onward) instead of reporting "Already current".`
    );
  }

  const from = before.head;
  if (before.behind > 0) {
    // --ff-only is the posture in one flag: if this cannot fast-forward, the
    // pre-flight missed something and git refuses rather than inventing a merge.
    if (!step(`fast-forward ${before.branch} → ${before.upstream} (${before.behind} commit(s))`, 'git', ['merge', '--ff-only', before.upstream]).ok) {
      return report;
    }
  }

  const after = readCurrency({ git });
  const changed = from === after.head
    ? []
    : git(['diff', '--name-only', from, after.head], { allowFail: true }).split('\n').filter(Boolean);
  if (changed.length) log(`\n${changed.length} file(s) changed ${from.slice(0, 7)}..${after.head_short}`);

  // npm ci only when the dependency set actually moved: it is the one step that
  // needs the network, and it deletes node_modules to do it.
  if (changed.includes('package-lock.json') || changed.includes('package.json')) {
    if (!step('dependencies moved — npm ci', 'npm', ['ci']).ok) return report;
  }

  // packages/*/dist and the TUI bundle are gitignored, so every machine builds
  // its own; hooks/*.mjs bundles are COMMITTED, so a consumer must not rebuild
  // them — npm run check verifies the committed ones are fresh instead.
  if (!step('build server + packages (npm run build)', 'npm', ['run', 'build']).ok) return report;
  if (!step('build TUI bundle (npm run build:tui)', 'npm', ['run', 'build:tui']).ok) return report;
  if (!step('consistency checks (npm run check)', 'npm', ['run', 'check'], { show: true }).ok) return report;
  // A red test battery is the ONE failure in this sequence that does not stop
  // it (decision update-red-test-battery-still-syncs-agents-skips-store-migration):
  // by the time the battery runs the fast-forward already landed, and every
  // project launches with --plugin-dir against THIS clone, so the new hooks
  // are already live everywhere — stopping before agent sync protects
  // nothing, it only leaves installed agent templates (low-risk text) out of
  // step with hooks already running. A store schema migration is different:
  // it is run by code the battery just called suspect, so it is the one step
  // held back. `step()` already sets report.exit=1 on this failure — never
  // swallowed, never a `return`.
  let testFailed = false;
  if (opts.test !== false) {
    if (!step('test battery (npm test)', 'npm', ['test']).ok) {
      testFailed = true;
      log(
        '\n✗ TEST BATTERY FAILED — store migration is SKIPPED below (schema changes are the one irreversible step, and this is code the battery has just called suspect). Agent sync still runs, because the hooks from this pull are already live in every project via --plugin-dir. This run exits non-zero and will NOT write the completion marker — rerun after fixing the battery, or the next /sterling:update resumes from here instead of reporting "Already current".'
      );
    }
  } else {
    log('\n▸ test battery — SKIPPED (--no-test)');
  }

  if (!testFailed) {
    let stores;
    try {
      stores = machineStores(cwd);
    } catch (err) {
      log(`\n✗ store enumeration FAILED — stopping. The fast-forward stands; ${err?.message ?? err}`);
      report.exit = 1;
      return report;
    }
    for (const store of stores) {
      let version;
      try {
        version = probeSchemaVersion(store);
      } catch (err) {
        log(`\n✗ store schema probe FAILED for '${store}' — stopping. The fast-forward stands; ${err?.message ?? err}`);
        report.exit = 1;
        return report;
      }
      if (version < 2) {
        if (!step(`migrate store schema v${version} → v2 (${store})`, nodeBin, [join(cwd, 'scripts', 'migrate-stores.mjs'), '--db', store, '--invoked-by', 'update-sweep'], { show: true }).ok) return report;
        // Review fix H2: an already-open MCP server keeps the schema verdict it
        // read at open, so a session that was live during migration refuses
        // writes until restarted — say so instead of leaving a mystery refusal.
        log(`  ▸ migrated: any Sterling session already open on this store must EXIT AND RELAUNCH the Claude Code CLI (a /clear is NOT enough — MCP servers survive it) before it can write again`);
      }
    }
  } else {
    log('\n▸ store migration (this clone) — SKIPPED (red test battery)');
  }

  // Re-bake this machine's generated artifacts against the new templates. The
  // ensure pass never overwrites what it cannot prove it generated, so a
  // hand-edited launcher is reported as `differs`, not clobbered.
  // THE GATE IS ABOUT THE CLONE-AS-PROJECT ARTIFACTS ONLY (board 2a6b45c2). It reads
  // like a bootstrap route and is not one: init REFUSES without recorded declarations,
  // so a clone that was never init'd cannot be re-baked from here, and the old skip
  // message told the reader to init the clone — advice that is now wrong. Since board
  // 2a6b45c2, .claude-plugin/sterling-mcp.json (the file plugin.json's `mcpServers`
  // names, and the ONLY thing here a consumer machine actually needs) is ensured in the
  // clone by EVERY /sterling:init run, whatever its --target — so a clone with no
  // .sterling/config.json is the NORMAL consumer shape, not a broken one, and nothing
  // is missing when this step is skipped.
  if (existsSync(join(cwd, '.sterling', 'config.json'))) {
    step('re-bake machine artifacts (init ensure pass)', nodeBin, [join(cwd, 'scripts', 'init.mjs'), '--target', cwd], { show: true, tolerate: true });
  } else {
    log(
      '\n▸ re-bake machine artifacts — SKIPPED: no .sterling/config.json in the Sterling clone. That is the NORMAL consumer shape and nothing is missing: the clone-as-project artifacts (its own launchers/CLAUDE.md/agents) are what this step bakes, and the plugin MCP config plugin.json points at is ensured in this clone by every /sterling:init run in ANY project (board 2a6b45c2). Run /sterling:init in a project — not here — if this machine has never done so.',
    );
  }

  // Stamp the consumer role now that the fast-forward + rebuild are complete
  // (todo cabbc10f, decision foreign_a9b98b7d) — running /sterling:update is exactly
  // what a consumer machine does, so a successful run here is the signal.
  // Never fatal: a stamping failure must not make a successful update report
  // as failed.
  stampConsumerRoleIfAbsent(cwd, log);

  // Installed agents are what actually breaks on a pull: template content moves,
  // and the hook commands baked into each project's .claude/agents carry THIS
  // machine's node + hooks paths. A refusal (locally modified agent) is surfaced,
  // never merged, and never stops the other projects.
  // Resolved HERE, not at startup: on a fresh clone the registry cannot be read
  // until the build above has run (see the projects param note).
  const projectList = opts.projects === false ? [] : (typeof projects === 'function' ? (await projects()) ?? [] : projects);
  // Review fix H1: the machine-store loop above covers this clone + the domain
  // stores, but every OTHER registered project on this machine has its own
  // .sterling store that the new code refuses to write until migrated — and
  // those projects never run /sterling:update themselves. Migrate them here,
  // where the registry is finally resolvable; a refusal stops the update
  // loudly, same contract as the machine-store loop.
  // CONTINUE-ON-FAILURE, matching the agent-sync loop below (board 2b37272a
  // claim B): a `return` here used to make one sibling's migration failure
  // skip every unprocessed project AND the entire agent-sync loop — the
  // originally-reported trigger is migrate-stores.mjs's own pre-mutation
  // verification refusal. `tolerate: true` keeps `step()` from setting
  // report.exit or returning on our behalf, so we can log per-project, record
  // it in report.migrations, and move on — continue-on-failure must still
  // surface non-zero overall, never swallow it.
  if (testFailed) {
    if (opts.projects !== false && projectList.length) {
      log('\n▸ per-project store migration — SKIPPED (red test battery)');
    }
  } else if (opts.projects !== false && projectList.length) {
    for (const p of projectList) {
      const projStore = join(p.repo_path, '.sterling', 'sterling.db');
      if (!existsSync(projStore)) continue;
      let projVersion;
      try {
        projVersion = probeSchemaVersion(projStore);
      } catch (err) {
        log(`\n✗ store schema probe FAILED for '${projStore}' (${p.name}) — this project's migration is SKIPPED; continuing with the remaining projects and the agent-sync fan-out below. ${err?.message ?? err}`);
        report.migrations.push({ name: p.name, repo_path: p.repo_path, ok: false, error: err?.message ?? String(err) });
        report.exit = report.exit === 0 ? 1 : report.exit;
        continue;
      }
      if (projVersion < 2) {
        const migrated = step(`migrate store schema v${projVersion} → v2 (${projStore})`, nodeBin, [join(cwd, 'scripts', 'migrate-stores.mjs'), '--db', projStore, '--invoked-by', 'update-sweep'], { show: true, tolerate: true });
        if (!migrated.ok) {
          log(`  ✗ ${p.name}: store migration FAILED — this project's store stays unmigrated; continuing with the remaining projects and the agent-sync fan-out below.`);
          report.migrations.push({ name: p.name, repo_path: p.repo_path, ok: false });
          report.exit = report.exit === 0 ? 1 : report.exit;
          continue;
        }
        report.migrations.push({ name: p.name, repo_path: p.repo_path, ok: true });
        log(`  ▸ migrated: any Sterling session already open on this store must EXIT AND RELAUNCH the Claude Code CLI (a /clear is NOT enough — MCP servers survive it) before it can write again`);
      }
    }
  }
  // The full fan-out rebuilds the provisioning state for every project it
  // visits; with --no-projects the previous record is kept as it was.
  provisioning = opts.projects === false ? { ...(readUpdateMarker(cwd, () => {})?.projects ?? {}) } : {};
  if (opts.projects !== false && projectList.length) {
    log(`\n▸ syncing agents across ${projectList.length} registered project(s)`);
    for (const p of projectList) {
      // An invalid project mode is its own refusal (never a "locally modified
      // agent"): nothing is synced or projected for the project, the core
      // marker is still stamped, and project_retry reruns both once it is fixed.
      if (projectModeOrRefuse(p) === null) {
        delete provisioning[p.repo_path];
        report.projects.push({ name: p.name, repo_path: p.repo_path, status: null, handoff: 'refused_project_mode' });
        continue;
      }
      const r = exec(nodeBin, [join(cwd, 'scripts', 'sync-agents.mjs'), '--target', p.repo_path], { cwd });
      const out = `${r.stdout}${r.stderr}`.trim();
      const statuses = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+: /.test(l));
      // config_drift (decision 256d1059) wrote nothing, so it is not a change; it is
      // relayed verbatim below (the line carries the fix command), never a failure.
      const driftedAgents = statuses.filter((l) => l.startsWith('config_drift: '));
      const changedAgents = statuses.filter((l) => !l.startsWith('up_to_date') && !l.startsWith('locally_modified_up_to_date') && !l.startsWith('config_drift: '));
      report.projects.push({ name: p.name, repo_path: p.repo_path, status: r.status, changed: changedAgents.length, config_drift: driftedAgents.length });
      if (r.status === 2) {
        log(`  ✗ ${p.name}: REFUSED — a locally modified agent. Output verbatim:\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        report.exit = 2;
      } else if (r.status !== 0) {
        log(`  ✗ ${p.name}: sync failed (exit ${r.status}):\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        report.exit = report.exit === 0 ? 1 : report.exit;
      } else {
        log(`  • ${p.name}: ${changedAgents.length ? changedAgents.join(', ') : driftedAgents.length ? 'no agent changes' : 'up to date'}`);
        for (const line of driftedAgents) log(`      ⚠ ${line}`);
      }
      const handoff = runHandoff(p);
      report.projects[report.projects.length - 1].handoff = handoff;
      recordProvisioning(p, after.head, r.status, handoff);
      // Deliver the double-click updater to every registered project — the
      // update event is how a machine receives new artifacts, so a project
      // init'd before this launcher existed gets one here rather than waiting
      // on someone remembering a per-project re-init (P4). Ensure semantics:
      // never overwrites what it cannot prove it generated; nonfatal always.
      try {
        const launcher = ensureUpdateLauncher(p.repo_path, cwd);
        if (launcher.status !== 'matches') log(`      ${UPDATE_LAUNCHER_NAME}: ${launcher.status} — ${launcher.detail}`);
      } catch (err) {
        log(`      ⚠ ${UPDATE_LAUNCHER_NAME} ensure FAILED (nonfatal): ${err?.message ?? err}`);
      }
      // Deliver the consumer-runnable checks entry the same way (board 4ccf0644):
      // a project init'd before this launcher existed otherwise never gets one.
      try {
        const checkLauncher = ensureConsumerCheckLauncher(p.repo_path, cwd);
        if (checkLauncher.status !== 'matches') log(`      ${CONSUMER_CHECK_LAUNCHER_NAME}: ${checkLauncher.status} — ${checkLauncher.detail}`);
      } catch (err) {
        log(`      ⚠ ${CONSUMER_CHECK_LAUNCHER_NAME} ensure FAILED (nonfatal): ${err?.message ?? err}`);
      }
    }
  } else if (opts.projects === false) {
    log('\n▸ project agent sync — SKIPPED (--no-projects)');
  }

  // Registry coverage — the SAME call the already-current path makes above.
  await reportCoverage(projectList);

  // Read-only: reports AGENTS.md/CLAUDE.md contract drift in sibling projects without
  // touching them (--apply stays a deliberate act — it rewrites seven repos).
  // TOLERATED because a sibling's AGENTS.md/CLAUDE.md must never abort THIS clone's update —
  // but tolerated is not the same as unseen: the step's own block sits between
  // build/test/check output, so its verdict is repeated in the closing summary
  // where it cannot scroll past (P1/P5). stamp-contract exits 2 on refusal.
  if (opts.projects !== false && existsSync(join(cwd, 'scripts', 'stamp-contract.mjs'))) {
    const contract = step('contract drift in sibling projects (stamp-contract, dry run)', nodeBin, [join(cwd, 'scripts', 'stamp-contract.mjs')], {
      show: true,
      tolerate: true,
    });
    report.contract_drift = !contract.ok;
  }

  log(
    `\n${'─'.repeat(60)}\n` +
      `Updated: ${before.head_short} → ${after.head_short}${after.describe && after.describe !== after.head_short ? ` (${after.describe})` : ''}\n` +
      (report.contract_drift
        ? 'CONTRACT DRIFT in a sibling project — see the stamp-contract block above. Tolerated here (a sibling CLAUDE.md never blocks this clone), and it does NOT self-heal: resolve the hand-tuned text, then `node scripts/stamp-contract.mjs --apply`.\n'
        : '') +
      'RESTART THE SESSION before working — that means EXIT AND RELAUNCH the Claude Code CLI (a /clear is NOT enough, MCP servers survive it): the MCP server and every project subagent load at CLI start, so the code now on disk is not the code running.'
  );

  // Stamp completion ONLY on a clean exit (board 2b37272a claim A) — a
  // per-project sync refusal or migration failure already left report.exit
  // non-zero above, and writing the marker anyway would make the NEXT
  // behind-0 run report "Already current" while that failure is still
  // unresolved. Never fatal: the update itself already succeeded by the time
  // this runs.
  // An actionable handoff refusal is NOT a core failure: the marker is stamped
  // with the unresolved project paths, and the next already-current run retries
  // only those (Sol re-check, the update wedge). The exit stays loud (2).
  if (report.exit === 0) {
    try {
      writeUpdateMarker(cwd, after.head, report.handoff_retry, provisioning, report.project_retry);
    } catch (err) {
      log(`\n⚠ update marker write FAILED (nonfatal — the update itself already succeeded): ${err?.message ?? err}`);
    }
    if (report.handoff_retry.length) {
      log(`\n✗ ${report.handoff_retry.length} project(s) have an unresolved handoff projection: ${report.handoff_retry.join(', ')} — the next /sterling:update retries only these.`);
      report.exit = 2;
    }
    if (report.project_retry.length) {
      log(`\n✗ ${report.project_retry.length} project(s) have an invalid project mode: ${report.project_retry.join(', ')} — fix config.mode ('hobby' or 'work', TUI System tab); the next /sterling:update reruns their agent sync and handoff projection.`);
      report.exit = 2;
    }
  }

  return report;
}
