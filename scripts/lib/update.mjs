// Consumer-machine update core [S] (decision foreign_e6240afe).
//
// WHY THIS EXISTS: Sterling was first distributed as a clone of origin, and
// nothing on a machine could answer "am I current?". The version strings never
// moved (0.1.0 since the first commit), so a stale machine could only be
// diagnosed by comparing its files against GitHub by hand. That spends judgment
// on a mechanical question (P3), and it is exactly how one machine's update
// became a file-by-file reconciliation.
//
// SCOPE TODAY (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone):
// the repo is also a /plugin marketplace, and a consumer machine installs from it
// with no clone. /sterling:update serves a git CLONE only. On the authoring
// machine it is SYNC-ONLY: no pull, it syncs the invoking project. On an installed
// copy it is REFUSED and says to update via /plugin.
//
// THE POSTURE for a clone that is not the authoring machine (a legacy consumer):
// it is a PURE CONSUMER of the default branch. A consumer never authors, so an
// update is a FAST-FORWARD OR A REFUSAL — never a merge, never a rebase, never a
// hand comparison. Divergence is reported for a human to resolve on the authoring
// machine (P5); the refusals below mutate nothing, which is what makes running
// this unattended safe.
//
// The logic lives here as pure-ish functions over an injected `exec` so the
// refusal matrix and the step ordering are unit-testable without a network, an
// npm install, or a 90-second test battery. scripts/update.mjs is the thin CLI.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// builtins-only module — safe at load time on an unbuilt clone (see the
// bootstrap-independence note in scripts/update.mjs).
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from './update-launcher.mjs';
import { ensureConsumerCheckLauncher, CONSUMER_CHECK_LAUNCHER_NAME } from './consumer-checks.mjs';
import { readProjectMode, ProjectModeError, readHandoffSetting, handoffUnmaintainedNotice, HandoffSettingError, HANDOFF_OFF_DETAIL } from './handoff-projection.mjs';
import { ContainmentError } from './contained-fs.mjs';
import { workIdentityRefusal, withIdentityIgnore, withNestedIgnore, IGNORE_NESTED } from './project-identity.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { installHostOf, sterlingUpdateRemedy } from './sterling-roots.mjs';

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
// consumer: (1) the committed esbuild BUNDLES — every shipped path in
// scripts/lib/bundled-artifacts.mjs BUNDLED_ARTIFACTS: hooks/*.mjs (committed so
// git protects the enforcement logic, decision foreign_2422e76a — hooks/hooks.json
// is NOT here, it is a hand-maintained registry), bin/*.mjs, mcp/sterling-mcp.mjs
// with its mcp/.build-id, and tui/sterling-tui.mjs (committed so a /plugin install
// runs with no node_modules; decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone);
// (2) the store PROJECTIONS architecture.md and rulings.md — the same pair
// .sterling/config.json lists under generated_projections and
// scripts/check-projection-fresh.mjs freshness-checks. rulings.md was missing
// from this list from the day it was added (board 778226f0), so a dirty one drew
// the "push from the authoring machine" remedy that can never be right for a
// projection; the bin/mcp/tui bundles would have drawn the same wrong remedy.
//
// A literal list, not an import of BUNDLED_ARTIFACTS: this module is itself
// bundled into bin/update.mjs, and the registry imports esbuild.
// scripts/tests/update.test.mjs pins every tracked file under every registered
// shipped path to this list, so a new family cannot ship without its remedy.
// This list does not decide WHICH files are at stake (git does, above); it only
// decides which REMEDY a refusal prints for a file git already reported.
const GENERATED_TRACKED = [
  /^hooks\/[^/]+\.mjs$/,
  /^bin\/[^/]+\.mjs$/,
  /^bin\/contract-history\.json$/,
  /^bin\/launcher-history\.json$/,
  /^mcp\/sterling-mcp\.mjs$/,
  /^mcp\/\.build-id$/,
  /^tui\/sterling-tui\.mjs$/,
  /^opencode\/sterling-server\.mjs$/,
  /^opencode\/sterling-tui\/sterling-tui\.bundle\.tsx$/,
  /^architecture\.md$/,
  /^rulings\.md$/,
];

/** Test seam: the remedy classification for one repo-relative path. */
export function isGeneratedTrackedPath(p) {
  return GENERATED_TRACKED.some((re) => re.test(p));
}

/** Path from a `git status --porcelain` line, resolving a rename to its DESTINATION. */
function porcelainPath(line) {
  const raw = line.slice(3).trim();
  const arrow = raw.lastIndexOf(' -> ');
  return (arrow === -1 ? raw : raw.slice(arrow + 4)).replace(/^"|"$/g, '');
}

function isGeneratedTracked(line) {
  return isGeneratedTrackedPath(porcelainPath(line));
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
          '  · hooks/*.mjs, bin/*.mjs, mcp/sterling-mcp.mjs (with mcp/.build-id) and tui/sterling-tui.mjs are esbuild bundles the update deliberately does NOT rebuild. A local rebuild here is not work worth keeping, and discarding cannot hide a defect: `npm run check` rebuilds every bundle from source into a temp dir and byte-compares it against the committed one, so a genuinely wrong bundle fails at the check step instead.\n' +
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

/**
 * The clone's declared machine role from <cwd>/.sterling/config.json
 * (`machine_role`), or null when undeclared, absent or unparseable — the safe
 * posture is consumer, the same fail-open read H1 and clone-currency make
 * inline (neither exports a reader this builtins-only module could import).
 */
export function readMachineRole(cwd) {
  try {
    const role = JSON.parse(readFileSync(join(cwd, '.sterling', 'config.json'), 'utf8')).machine_role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

const normPath = (p) => {
  const t = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? t.toLowerCase() : t;
};

// A launcher baked before the plugin layout runs the old, gitignored TUI build, which
// shows an outdated dashboard with no error (board 7a8986e2). The consumer path prints one
// line for every project; the authoring branch returns before it, so it reads the
// invoking project's launcher itself. READ-ONLY: the authoring update touches no launcher
// (commands/update.md), and re-baking is init's job.
const OLD_TUI_BUNDLE = 'packages/tui/bundle/sterling-tui.mjs';
const SHIPPED_TUI_BUNDLE = 'tui/sterling-tui.mjs';

/**
 * Warn when `<repoPath>/sterling-launch.sh` still names the old TUI bundle path. No
 * launcher is normal (not every project has one) and prints nothing. A launcher that
 * cannot be read is reported with the reason and does not fail the update: the sync it
 * came for succeeded and this check is advisory, but staying silent would let the stale
 * dashboard hide again (P5).
 */
export function warnIfLauncherNamesOldBundle(repoPath, log) {
  const launcher = join(repoPath, 'sterling-launch.sh');
  if (!existsSync(launcher)) return;
  let text;
  try {
    text = readFileSync(launcher, 'utf8');
  } catch (err) {
    log(`✗ could not read ${launcher} (${err.code ?? err.message}), so it was not checked for the old TUI bundle path ${OLD_TUI_BUNDLE}. Open it and confirm it runs ${SHIPPED_TUI_BUNDLE}.`);
    return;
  }
  if (text.includes(OLD_TUI_BUNDLE)) {
    log(`✗ ${repoPath}: sterling-launch.sh still runs ${OLD_TUI_BUNDLE}, which no longer ships, so its dashboard is outdated and shows no error. Re-run /sterling:init in this project so its launcher runs ${SHIPPED_TUI_BUNDLE} (this update did not touch the launcher).`);
  }
}

/**
 * Which registered project an authoring-machine update was invoked for: the
 * directory (CLAUDE_PROJECT_DIR when set, else the shell cwd) must EQUAL or sit
 * INSIDE a registered repo_path; the nearest such ancestor wins. null when it
 * is none — a set-but-unregistered CLAUDE_PROJECT_DIR is never replaced by cwd.
 */
export function resolveInvokingProject(list, { projectDir, cwd }) {
  const dir = normPath(projectDir || cwd);
  let best = null;
  for (const p of list) {
    const root = normPath(p.repo_path);
    if ((dir === root || dir.startsWith(`${root}/`)) && (!best || root.length > normPath(best.repo_path).length)) best = p;
  }
  return best;
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

// RE-EXEC AFTER THE FAST-FORWARD (decision gap-hunt-2026-09-28-rulings item 9).
// Everything after the ff-merge used to run in the OLD code this process loaded
// before the merge, so an upgrading machine needed a second /sterling:update
// before the new update logic applied. After a successful fast-forward the CLI
// hands off ONCE to the NEW scripts/update.mjs; the child sees behind 0 with no
// completion marker at the new head and resumes the full post-merge sequence.
// The guard is this env flag: the CLI builds no re-exec hook when it is set, so
// the child can never re-exec again.
export const UPDATE_REEXEC_ENV = 'STERLING_UPDATE_REEXEC';
// The parent's PRE-merge head, handed to the child (review HIGH-1): the child
// starts after the fast-forward, so its own starting head already equals the
// new head and could never see what the pull changed (npm ci, the changed-file
// count). runUpdate takes it as opts.from.
export const UPDATE_REEXEC_FROM_ENV = 'STERLING_UPDATE_REEXEC_FROM';

/** The child's argv: the parent's own flags, plus --no-fetch (the parent
 *  already fetched, and the child must not move the target it was handed).
 *  A --target value is replaced by the parent's RESOLVED absolute target
 *  (review LOW-1): the child runs with cwd = the target, where a relative
 *  path would resolve somewhere else. */
export function reexecArgs(argv, { target }) {
  const out = [...argv];
  const i = out.indexOf('--target');
  if (i !== -1 && i + 1 < out.length) out[i + 1] = target;
  return out.includes('--no-fetch') ? out : [...out, '--no-fetch'];
}

// PRE-SCALE-DOWN CLAUDE.md (decision gap-hunt-2026-09-28-rulings item 7). The
// identifiers below name mechanisms the scale-down deleted (decision
// sterling-claude-code-scale-down-boundary, landed 8df86a6 on 2026-09-19): the
// run signal/state tools, the review ledger and its trailer, the frozen-test
// wall. Measured: templates/target-claude-md.md at 8df86a6^ carries run_signal,
// run_state, Reviewed-By-Agent, review-ledger and frozen-test, and no template
// since carries any of them. So a project CLAUDE.md that mentions one was
// rendered before the scale-down and still instructs its session to use tools
// that no longer exist. /sterling:init migrates it; update only names it.
export const PRE_SCALE_DOWN_MARKERS = Object.freeze(['run_signal', 'run_state', 'Reviewed-By-Agent', 'review-ledger', 'frozen-test']);

export function preScaleDownMarkers(text) {
  return PRE_SCALE_DOWN_MARKERS.filter((m) => text.includes(m));
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
 *
 * The marker attests the CORE update only (install, build, check, test,
 * migrations, re-bake) — never per-project state. Per-project convergence comes
 * from the refresh pass every run makes (decision
 * project-mode-hobby-work-toggle-decides-flow, Astra design review item 2).
 * A marker written before that rebuild may still carry `projects`,
 * `project_retry` or `handoff_retry`: they are ignored, never validated, so an
 * old marker neither degrades to a resume nor schedules anything.
 */
function readUpdateMarker(cwd, log) {
  const p = join(cwd, UPDATE_MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed?.sha !== 'string' || !parsed.sha) throw new Error('missing or invalid "sha" field');
    return { sha: parsed.sha };
  } catch (err) {
    log(`\n⚠ update marker '${p}' is corrupt/unreadable — degrading to a full resume rather than trusting a marker that cannot be verified: ${err?.message ?? err}`);
    return null;
  }
}

/** Written ONLY once runUpdate's core sequence has completed cleanly — see the
 *  call site. A halted or failed core run must never leave a marker that makes
 *  the NEXT run skip the core without it having actually finished. */
function writeUpdateMarker(cwd, sha) {
  const p = join(cwd, UPDATE_MARKER_RELATIVE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ sha, completed_at: new Date().toISOString() }, null, 2) + '\n');
}

// THE DOMAIN MAP AFTER AN UPDATE (board item
// the-domain-map-runs-by-itself-the-first-time-after-an-update; decision
// consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command). The
// per-project pass runs `domains.mjs --target <project> --json` and prints a proposal
// when the map has one. It never passes --apply: a mount is added only by
// /sterling:domains after the user agrees. A project with a proposal also gets this
// file, which the project's next session start (H1, scripts/hooks/lib/domain-notice.mjs)
// reads to print one line and then deletes, so the line shows once. Its content is the
// time it was written and is never parsed: H1 computes the map again. An installed copy
// writes no such file; there the post-update sync is the trigger.
export const DOMAIN_MAP_PENDING_REL = join('.sterling', 'domain-map-pending');

/**
 * The proposal in `domains.mjs --json` output: the domains the project should add, and
 * whether that run put the project into the registry. Throws on output that is not a map.
 */
export function parseDomainProposal(stdout) {
  const map = JSON.parse(stdout);
  if (!Array.isArray(map?.proposal?.add)) throw new Error('the output carries no proposal list');
  return { add: map.proposal.add.map((a) => ({ domain: a.domain, reason: a.reason })), registered: map.registered_by_this_run === true };
}

// A Node filesystem error (EACCES, EPERM, EIO, ...) raised while reading ONE
// project's files: a per-project refusal, never an abort of the machine-wide
// update (Sol re-check). contained-fs rethrows every non-ENOENT lstat error.
const isFsError = (err) => typeof err?.code === 'string' && typeof err?.syscall === 'string';
// The refusals a per-project read may raise: an invalid mode, an invalid
// handoff setting, an unsafe path, or a filesystem error.
const isProjectReadRefusal = (err) => err instanceof ProjectModeError || err instanceof HandoffSettingError || err instanceof ContainmentError || isFsError(err);

// What to do about a project whose handoff refusal will not go away by itself.
export function handoffRefusalRemedy(repoPath) {
  return (
    `fix it in ${repoPath} and rerun /sterling:update (every registered project is refreshed on every run). ` +
    `If it cannot be repaired: retire it (move or delete the project, then \`node scripts/list-projects.mjs --prune-missing\` unregisters it), ` +
    `or set "store_authority": "secondary" in its .sterling/config.json so the refusal becomes a standing one.`
  );
}

/** The plugin root this module runs from: the nearest ancestor carrying
 *  .claude-plugin/plugin.json (a walk-up, so it holds for scripts/lib/ and for a
 *  bundled bin/ entry alike). null when no plugin tree sits above it. */
function ownPluginRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** The refusal for an installed copy, naming the update command of the host it was
 *  installed by (installHostOf); null (a copy under neither install root) names both. */
export function installedCopyRefusal(host, { env = process.env, home = homedir(), root = null } = {}) {
  const by = host === 'claude-code' ? 'as a Claude Code plugin' : host === 'opencode' ? 'as an OpenCode plugin' : 'as a plugin';
  return `Sterling is installed ${by} — update it with ${sterlingUpdateRemedy(host, { env, home, root })}. /sterling:update serves only a git clone of Sterling.`;
}

/** Existing project + domain stores, without opening any database connection. */
export function machineStores(cwd) {
  const stores = [join(cwd, '.sterling', 'sterling.db')];
  const domains = join(homedir(), '.sterling', 'domains');
  if (existsSync(domains)) {
    for (const name of readdirSync(domains).sort()) {
      stores.push(join(domains, name, 'sterling.db'));
    }
  }
  return stores.filter((store) => existsSync(store));
}

/**
 * user_version as the last COMMITTED page 1 in `<db>-wal` states it, or null when
 * the WAL holds no committed page 1. The stores run in WAL mode, so while any
 * connection holds a store open (the MCP server, concurrently with SessionStart)
 * the main file's header can lag the truth — a fresh store reads 0 there until its
 * first checkpoint. Frames count only while their salts match the WAL header (a
 * reset WAL leaves stale frames behind), and a page-1 frame only once a commit
 * frame follows it. Checksums are not verified: this is a probe that prints a
 * line, never a reader that acts on data.
 */
function walUserVersion(dbPath) {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return null;
  const wal = readFileSync(walPath);
  if (wal.length < 32) return null;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return null;
  const pageSize = wal.readUInt32BE(8);
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let pending = null;
  let committed = null;
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
    if (wal.readUInt32BE(off) === 1) pending = wal.readUInt32BE(off + 24 + 60);
    if (wal.readUInt32BE(off + 4) !== 0 && pending !== null) committed = pending;
  }
  return committed;
}

/** SQLite's application-owned user_version is the big-endian u32 at header offset 60 —
 *  read from the WAL's last committed page 1 when there is one (see walUserVersion). */
export function probeSchemaVersion(dbPath) {
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
  return walUserVersion(dbPath) ?? header.readUInt32BE(60);
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
export async function runUpdate({ cwd, exec = defaultExec, log = console.log, projects = [], opts = {}, reexec = null, invokingProject = null, projectDir = null, pluginRoot = ownPluginRoot(), env = process.env, home = homedir() }) {
  // INSTALLED COPY (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
  // design point D): an installed Sterling (Claude Code's /plugin or `opencode plugin add`) is
  // updated by its host — there is nothing here to fetch, build or fan out. Refused before anything
  // else runs. env/home locate the install roots (scripts/lib/sterling-roots.mjs); tests inject them.
  if (pluginRoot && isInstalledCopy(pluginRoot, { env, home })) {
    const refusal = installedCopyRefusal(installHostOf(pluginRoot, { env, home }), { env, home, root: pluginRoot });
    log(`\n✗ ${refusal}`);
    return { exit: 2, currency: null, steps: [], projects: [], migrations: [], refusal };
  }
  const git = gitFrom(exec, cwd);
  const nodeBin = opts.nodeBin ?? process.execPath;
  const report = { exit: 0, currency: null, steps: [], projects: [], migrations: [], refusal: null };
  // Keeps the FIRST non-zero exit: a later, milder per-project outcome never
  // masks an earlier failure.
  const fail = (code) => {
    if (report.exit === 0) report.exit = code;
  };
  // The registered project list, resolved the SAME way on both paths. An
  // unreadable registry (or an unloadable store module) is never an empty list:
  // it is logged and null is returned, so no project is refreshed, and the
  // caller records exit 2. On the FULL path it also withholds the marker: the
  // per-project store migrations (schema changes) could not run, so the next
  // update must redo the full sequence rather than skip them behind a stamp.
  // Set on failure so the later "registry could not be read" summary (below)
  // can repeat the path and remedy instead of pointing back up with "see above".
  let registryFailureDetail = null;
  const resolveProjects = async ({ includeClone = false } = {}) => {
    try {
      return typeof projects === 'function' ? (await projects({ includeClone })) ?? [] : projects;
    } catch (err) {
      // Name the registry file so the remedy is actionable, not just "see
      // above" (board residual, LOW). Resolved the SAME way loadProjects does
      // (scripts/update.mjs). When @sterling/store itself cannot load, this
      // second import fails identically and pathHint stays empty — err.message
      // below already carries that case's own remedy (npm run build).
      let pathHint = '';
      try {
        const store = await import('@sterling/store');
        pathHint = ` at ${store.registryPath()}`;
      } catch {
        // no path to add — see the comment above.
      }
      const remedy = pathHint ? ' Make it readable or unlocked, or restore it, then rerun /sterling:update.' : '';
      registryFailureDetail = `project registry${pathHint} unavailable: ${err?.message ?? err}${remedy}`;
      log(`\n✗ per-project refresh SKIPPED — ${registryFailureDetail}`);
      return null;
    }
  };

  // THE PER-PROJECT REFRESH (decision project-mode-hobby-work-toggle-decides-flow,
  // Astra design review item 2 — rebuilt as ONE idempotent pass). Every explicit
  // update visits each registered target exactly once, on the full path and the
  // already-current path alike; the target's CURRENT handoff setting
  // (config.handoff.enabled, decision
  // project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting),
  // read from its own config, decides what runs. The mode decides nothing here:
  //   - valid config: sync-agents (it gates the portable agents on the setting itself);
  //   - handoff on: also the handoff projection; off: no portable-file
  //     maintenance, nothing deleted;
  //   - an invalid mode, an invalid handoff setting, or a filesystem/containment
  //     error reading them: a visible per-project refusal, each its own class,
  //     exit 2, nothing synced or projected.
  // The generators carry every safety guard (containment, foreign/local-edit
  // refusal, store authority, missing/empty-store protection, unchanged-byte
  // preservation), so running them on every update converges the files without
  // any persisted schedule. One target's failure never stops another's refresh.
  // This guarantees convergence when refresh runs, not freshness between runs.
  // Returns the number of targets whose refresh failed or was refused.
  const refreshProjects = (list, { launchers, handoff: withHandoff = true }) => {
    let failures = 0;
    for (const p of list) {
      const entry = { name: p.name, repo_path: p.repo_path, status: null };
      report.projects.push(entry);
      let projectMode;
      try {
        projectMode = readProjectMode(p.repo_path);
      } catch (err) {
        if (!isProjectReadRefusal(err)) throw err;
        log(`  ✗ ${p.name}: REFUSED — project mode: ${err.message}. Nothing was synced or projected for this project; fix config.mode ('hobby' or 'work', TUI System tab) and rerun /sterling:update.`);
        entry.handoff = 'refused_project_mode';
        fail(2);
        failures++;
        continue;
      }
      // Work-project identity (decision work-project-identity-file-sterling-project-json):
      // a work project without a valid .sterling/project.json is refused, like an
      // invalid mode; a project is checked when it is in work mode or its config.storage is postgres.
      const identityRefusal = workIdentityRefusal(p.repo_path, projectMode);
      if (identityRefusal) {
        log(`  ✗ ${p.name}: REFUSED — ${identityRefusal}. Nothing was synced or projected for this project.`);
        entry.handoff = 'refused_project_identity';
        fail(2);
        failures++;
        continue;
      }
      // Repair the .gitignore of a project init'd before the identity file existed:
      // `.sterling/` becomes `.sterling/*` plus `!.sterling/project.json`, so the file
      // can be committed. Only an existing Sterling ignore line is rewritten.
      const gitignorePath = join(p.repo_path, '.gitignore');
      if (existsSync(gitignorePath)) {
        const repaired = withIdentityIgnore(readFileSync(gitignorePath, 'utf8'), { addIfAbsent: false });
        if (repaired.changed) {
          writeFileSync(gitignorePath, repaired.text);
          log(`      .gitignore: .sterling/ is now .sterling/* plus !.sterling/project.json, so .sterling/project.json can be committed`);
          entry.gitignore_repaired = true;
        }
        // `.sterling/*` is anchored to the repo root; the nested form keeps a stray
        // .sterling/ deeper in the tree ignored too.
        const nested = withNestedIgnore(repaired.text);
        if (nested.changed) {
          writeFileSync(gitignorePath, nested.text);
          log(`      .gitignore: added ${IGNORE_NESTED} so a nested .sterling/ directory stays ignored`);
          entry.gitignore_repaired = true;
        }
      }
      let handoffEnabled;
      let handoffUnmaintained;
      try {
        ({ enabled: handoffEnabled, unmaintained: handoffUnmaintained } = readHandoffSetting(p.repo_path));
      } catch (err) {
        if (!isProjectReadRefusal(err)) throw err;
        log(`  ✗ ${p.name}: REFUSED — handoff setting: ${err.message}. Nothing was synced or projected for this project; set config.handoff.enabled to true or false (TUI System tab) and rerun /sterling:update.`);
        entry.handoff = 'refused_handoff_setting';
        fail(2);
        failures++;
        continue;
      }
      let failed = false;
      const r = exec(nodeBin, [join(cwd, 'scripts', 'sync-agents.mjs'), '--target', p.repo_path], { cwd });
      const out = `${r.stdout}${r.stderr}`.trim();
      const statuses = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+: /.test(l));
      // config_drift (decision 256d1059) wrote nothing, so it is not a change; it is
      // relayed verbatim below (the line carries the fix command), never a failure.
      const driftedAgents = statuses.filter((l) => l.startsWith('config_drift: '));
      // The auto-memory NOTICE (an explicit non-false autoMemoryEnabled, kept; exit 0).
      // Its status line is hyphenated, so the agent-status filter above never matches it;
      // relayed from stdout only — the stderr NOTICE: line carries the same text.
      const autoMemoryNotices = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^auto-memory off: (kept|wrong_type)\b/.test(l));
      const changedAgents = statuses.filter((l) => !l.startsWith('up_to_date') && !l.startsWith('locally_modified_up_to_date') && !l.startsWith('config_drift: '));
      Object.assign(entry, { status: r.status, changed: changedAgents.length, config_drift: driftedAgents.length });
      if (r.status === 2) {
        log(`  ✗ ${p.name}: agent sync REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign "agent" in .claude/settings.json, or a .claude/settings.json that is not valid JSON or not a JSON object). Output verbatim:\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        fail(2);
        failed = true;
      } else if (r.status !== 0) {
        log(`  ✗ ${p.name}: agent sync failed (exit ${r.status}):\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        fail(1);
        failed = true;
      } else {
        log(`  • ${p.name}: ${changedAgents.length ? changedAgents.join(', ') : driftedAgents.length ? 'no agent changes' : 'up to date'}`);
        for (const line of driftedAgents) log(`      ⚠ ${line}`);
        for (const line of autoMemoryNotices) log(`      ⚠ ${line}`);
      }
      // An absent handoff key with handoff files on disk that git does not track:
      // they stopped being maintained, so the run names them (sync-agents prints
      // the same line, but its output is relayed only on a failure).
      if (handoffUnmaintained.length) log(`      ⚠ ${handoffUnmaintainedNotice(handoffUnmaintained)}`);
      // Handoff projection (decision
      // init-prepares-opencode-portable-agents-and-target-handoff-projections):
      // refresh the project's committed architecture.md / rulings.md /
      // docs/sterling/ from ITS OWN store. Exit 2 is a STANDING refusal (a
      // secondary store): a visible ⚠ skip, never a failure. Exit 3 is an
      // ACTIONABLE refusal (a hand-written file, symlink or ignore rule in the way,
      // a missing or empty store): exit 2. Anything else non-zero may have left an
      // INCOMPLETE export: exit 1.
      if (!withHandoff) {
        entry.handoff = 'not_run';
      } else if (!handoffEnabled) {
        log(`      skipped — ${HANDOFF_OFF_DETAIL}`);
        entry.handoff = 'skipped';
      } else {
        const handoff = exec(nodeBin, [join(cwd, 'scripts', 'handoff-projection.mjs'), p.repo_path], { cwd });
        const handoffOut = `${handoff.stdout}${handoff.stderr}`.trim();
        const handoffLine = handoffOut.split('\n')[0];
        entry.handoff = handoff.status;
        if (handoff.status === 2) {
          log(`      ⚠ ${handoffLine}`);
        } else if (handoff.status === 3) {
          log(`      ✗ ${handoffLine}\n        (${handoffRefusalRemedy(p.repo_path)})`);
          fail(2);
          failed = true;
        } else if (handoff.status !== 0) {
          log(`      ✗ handoff projection FAILED (exit ${handoff.status}) — the export may be INCOMPLETE:\n${handoffOut.split('\n').map((l) => `          ${l}`).join('\n')}`);
          fail(1);
          failed = true;
        } else if (!handoffLine.startsWith('handoff projection: unchanged')) {
          log(`      ${handoffLine}`);
        }
      }
      if (failed) failures++;
      // The domain map for this project (DOMAIN_MAP_PENDING_REL above): quiet when it
      // proposes nothing, never applied, and never a reason to fail the update. A
      // target with no config is not an initialized project, so it has no mounts to check.
      if (existsSync(join(p.repo_path, '.sterling', 'config.json'))) {
        try {
          const dm = exec(nodeBin, [join(cwd, 'scripts', 'domains.mjs'), '--target', p.repo_path, '--json'], { cwd });
          if (dm.status !== 0) throw new Error(`exit ${dm.status}: ${`${dm.stdout}${dm.stderr}`.trim().split('\n').slice(-3).join(' | ')}`);
          const { add } = parseDomainProposal(dm.stdout);
          entry.domain_proposal = add.map((a) => a.domain);
          if (add.length) {
            for (const a of add) log(`      domains: proposes adding '${a.domain}' — ${a.reason}`);
            log(`      Nothing was applied. Run /sterling:domains in ${p.repo_path} to see the map; it adds a domain only after you agree.`);
            writeFileSync(join(p.repo_path, DOMAIN_MAP_PENDING_REL), `${new Date().toISOString()}\n`);
          }
        } catch (err) {
          log(`      ⚠ domain map FAILED (nonfatal): ${err?.message ?? err}. Run /sterling:domains in ${p.repo_path} to see it.`);
        }
      }
      if (!launchers) continue;
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
    return failures;
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

  // AUTHORING MACHINE (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
  // point 5, user-ruled 2026-09-30 'Sync only'). Work lands in this clone, so there is nothing
  // to pull, and the check battery compares the committed projection against a store that is
  // legitimately newer (Dome Farmer, docs/sterling-issues.md:109-116). A ROLE branch, not a
  // --no-check flag (already-current-requires-a-completion-marker-not-git-currency rejects the
  // flag). Only the INVOKING project is synced — no registry fan-out, no handoff projection
  // (it would regenerate architecture.md from the store: the very drift this avoids), no
  // launchers. The marker is NOT written: it attests the full post-merge sequence, which did
  // not run; the authoring branch never reads it either, so it cannot go stale-and-bite.
  // The invoking directory must be a REGISTERED project (or inside one): sync-agents would
  // otherwise install a whole agent roster into whatever directory the shell happened to be in.
  if (readMachineRole(cwd) === 'authoring') {
    if (!invokingProject && !projectDir) {
      log('\n✗ AUTHORING clone — cannot tell which project to sync: no invoking directory was passed to the updater. Run it from the project (node scripts/update.mjs with that project as the working directory).');
      report.exit = 1;
      return report;
    }
    const invokedFrom = projectDir || invokingProject;
    if (opts.check) {
      log(`\nAUTHORING clone — nothing to pull; syncing ${invokedFrom} only`);
      log('  (--check: nothing fetched, nothing synced, no currency line — there is nothing to pull)');
      return report;
    }
    if (opts.projects === false) {
      log(`\nAUTHORING clone — nothing to pull; syncing ${invokedFrom} only`);
      log('  (--no-projects: nothing synced — on the authoring machine the project sync is the whole update, so this run did nothing)');
      return report;
    }
    const registered = await resolveProjects({ includeClone: true });
    if (registered === null) {
      log('\n✗ AUTHORING clone — the project registry could not be read, so the invoking project cannot be identified; nothing was synced.');
      report.exit = 2;
      return report;
    }
    const project = resolveInvokingProject(registered, { projectDir, cwd: invokingProject });
    if (!project) {
      log(`\n✗ AUTHORING clone — ${invokedFrom} is not a registered project (nor inside one), so nothing was synced: sync-agents would install a whole agent roster into it. Run /sterling:update from a project registered with /sterling:init (registered: ${registered.map((p) => p.repo_path).join(', ') || 'none'}).`);
      report.exit = 2;
      return report;
    }
    log(`\nAUTHORING clone — nothing to pull; syncing ${project.repo_path} only`);
    if (opts.force) log('  (--force has no meaning on the authoring machine: there is no rebuild to force)');
    refreshProjects([project], { launchers: false, handoff: false });
    warnIfLauncherNamesOldBundle(project.repo_path, log);
    if (normPath(project.repo_path) === normPath(cwd)) {
      log("▸ the clone's contract files are hand-maintained — not checked");
    } else if (existsSync(join(cwd, 'scripts', 'stamp-contract.mjs'))) {
      // --apply-inserts: see the sibling-projects step below.
      const contract = step('contract text in the invoking project (stamp-contract: new text inserted, wording changes reported only)', nodeBin, [join(cwd, 'scripts', 'stamp-contract.mjs'), '--apply-inserts', '--project', project.repo_path], {
        show: true,
        tolerate: true,
      });
      report.contract_drift = !contract.ok;
      // stamp-contract skips an unregistered or missing path and exits 0 with "0 project(s)
      // processed": a green that checked nothing is exactly what P5 forbids.
      if (contract.ok && /—\s*0 project\(s\) processed/.test(contract.out)) {
        report.contract_unchecked = true;
        log(`✗ stamp-contract checked NOTHING for ${project.repo_path} (0 project(s) processed) — the project is not reachable through the registry stamp-contract reads. Fix the registration and rerun.`);
        fail(1);
      }
      if (report.contract_drift) log('CONTRACT DRIFT in the invoking project — see the stamp-contract block above. Tolerated; resolve the hand-tuned text, then `node scripts/stamp-contract.mjs --apply --project <path>`.');
    }
    log('RESTART THE SESSION if agents changed — subagents load at CLI start.');
    return report;
  }

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
  const reportCoverage = async (list, registryOk = true) => {
    if (opts.projects === false) return;
    if (!registryOk) {
      // The registry itself could not be read (resolveProjects returned null),
      // so `list` is [] for a reason that has nothing to do with coverage: an
      // empty list here would either falsely call registered siblings
      // unregistered, or print an affirmative "ok" while the registry that
      // 'ok' depends on is unknown. Neither claim is safe to make.
      log('\n▸ registry coverage — SKIPPED: the project registry could not be read, so coverage is UNKNOWN (neither "ok" nor "unregistered" can be asserted).');
      return;
    }
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

  // PROJECT HYGIENE DISCLOSURES (decision gap-hunt-2026-09-28-rulings items 7
  // and 12), on both paths like the coverage report: a CLAUDE.md rendered before
  // the scale-down, and .sterling/config.json keys Sterling no longer reads
  // (nested ones by dotted path, e.g. models.coder, with the known renames).
  // REPORTS ONLY: nothing is rewritten or deleted and report.exit never moves.
  // The clone's own config is checked too; its CLAUDE.md is tracked source, not
  // a generated render, so it is not.
  const reportProjectHygiene = async (list) => {
    if (opts.projects === false) return;
    let describe;
    try {
      // Dynamic for bootstrap independence (see reportCoverage): by now the
      // build has run on the full path, and the already-current path had it.
      const schemas = await import('@sterling/schemas');
      describe = (raw) => {
        const keys = schemas.unreadConfigKeys(raw);
        return keys.length ? schemas.describeUnreadConfigKeys(keys) : null;
      };
    } catch (err) {
      log(`\n⚠ unread-config-key check SKIPPED — @sterling/schemas could not load (nonfatal): ${err?.message ?? err}`);
    }
    const lines = [];
    for (const p of [{ name: 'Sterling clone', repo_path: cwd, clone: true }, ...list]) {
      if (!p.clone) {
        const claudePath = join(p.repo_path, 'CLAUDE.md');
        try {
          if (existsSync(claudePath)) {
            const markers = preScaleDownMarkers(readFileSync(claudePath, 'utf8'));
            if (markers.length) lines.push(`  ⚠ ${p.name}: CLAUDE.md predates the scale-down (mentions ${markers.join(', ')}) — run /sterling:init there (${p.repo_path}) to migrate it`);
          }
        } catch (err) {
          lines.push(`  ⚠ ${p.name}: pre-scale-down CLAUDE.md check skipped — ${claudePath} could not be read: ${err?.message ?? err}`);
        }
      }
      if (!describe) continue;
      const configPath = join(p.repo_path, '.sterling', 'config.json');
      if (!existsSync(configPath)) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch (err) {
        lines.push(`  ⚠ ${p.name}: unread-config-key check skipped — .sterling/config.json could not be parsed: ${err?.message ?? err}`);
        continue;
      }
      const text = describe(raw);
      if (text) lines.push(`  ⚠ ${p.name}: .sterling/config.json carries ${text}`);
    }
    if (lines.length) log(`\n▸ project hygiene (disclosure only — nothing was changed)\n${lines.join('\n')}`);
  };

  if (before.behind === 0 && !opts.force) {
    const marker = readUpdateMarker(cwd, log);
    const markerSha = marker?.sha ?? null;
    if (markerSha === before.head) {
      // The core update is complete at this head: nothing is installed, built,
      // tested or migrated. The per-project pass still runs — every target once.
      const resolved = opts.projects === false ? [] : await resolveProjects();
      const registryOk = resolved !== null;
      if (!registryOk) fail(2);
      const list = resolved ?? [];
      // The blind spot this reports is INDEPENDENT of clone lag — an
      // already-current clone with two unregistered projects is the measured
      // 2026-08-28 state exactly — so the report belongs on this path too.
      await reportCoverage(list, registryOk);
      await reportProjectHygiene(list);
      let failures = 0;
      if (opts.projects === false) {
        log('\n▸ project refresh — SKIPPED (--no-projects)');
      } else if (list.length) {
        log(`\n▸ already current at ${before.head_short}; refreshing ${list.length} registered project(s) — each once, by its current mode (unchanged files stay byte-identical)`);
        failures = refreshProjects(list, { launchers: false });
      }
      if (report.exit === 0) {
        log(`\nAlready current — nothing to do for the core update at ${before.head_short}${list.length ? `; ${list.length} registered project(s) refreshed` : ''}. (Rerun with --force to rebuild and re-sync anyway.)`);
      } else if (registryOk) {
        log(`\n✗ the core update is already current at ${before.head_short}, but ${failures} project(s) failed their refresh (above) — fix them and rerun /sterling:update; every registered project is refreshed on every run.`);
      }
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

  let from = before.head;
  if (before.behind > 0) {
    // --ff-only is the posture in one flag: if this cannot fast-forward, the
    // pre-flight missed something and git refuses rather than inventing a merge.
    if (!step(`fast-forward ${before.branch} → ${before.upstream} (${before.behind} commit(s))`, 'git', ['merge', '--ff-only', before.upstream]).ok) {
      return report;
    }
    // Hand off to the NEW updater (see UPDATE_REEXEC_ENV). Only after a real
    // fast-forward: with nothing merged, the code on disk IS the code running.
    // The child's exit is this update's exit; a child that could not run at
    // all is a loud failure (P5), never an exit 0.
    if (reexec) {
      const script = join(cwd, 'scripts', 'update.mjs');
      const failed = (why) => {
        log(`\n✗ RE-EXEC of the updated updater FAILED — ${why}. The fast-forward stands and nothing after it ran; rerun /sterling:update to finish (it resumes from the build step).`);
        report.exit = 1;
        return report;
      };
      if (!existsSync(script)) return failed(`${script} not found after the fast-forward`);
      log(`\n▸ re-running the UPDATED updater (${script}) so the rest of this update runs the code just pulled`);
      // `from` is this process's PRE-merge head: the child starts after the
      // merge and needs it to see what the pull changed (review HIGH-1).
      const r = await reexec(script, { from: before.head });
      report.reexec = { status: r?.status ?? null, signal: r?.signal ?? null };
      if (r?.error) return failed(`could not start it: ${r.error.message ?? r.error}`);
      if (r?.signal) return failed(`it was killed by ${r.signal}`);
      if (typeof r?.status !== 'number') return failed('it returned no exit status');
      report.exit = r.status;
      return report;
    }
  }

  const after = readCurrency({ git });
  let changed;
  // The dependency set is UNKNOWN when a re-exec child cannot use the head it
  // was handed; npm ci then runs rather than being skipped (P5: an unknown
  // never reads as "nothing moved").
  let dependenciesUnknown = false;
  if (opts.from === undefined || opts.from === null || opts.from === '') {
    changed = from === after.head
      ? []
      : git(['diff', '--name-only', from, after.head], { allowFail: true }).split('\n').filter(Boolean);
  } else if (!/^[0-9a-f]{40}$/.test(opts.from)) {
    log(`\n⚠ the pre-merge head handed over by the parent update ('${opts.from}') is not a commit sha — what the pull changed is UNKNOWN, so npm ci runs rather than being skipped`);
    changed = [];
    dependenciesUnknown = true;
  } else {
    // A re-exec child (review HIGH-1): its own starting head already IS the new
    // head, so it diffs from the parent's pre-merge head instead.
    from = opts.from;
    const d = from === after.head ? { status: 0, stdout: '' } : exec('git', ['diff', '--name-only', from, after.head], { cwd });
    if (d.status !== 0) {
      log(`\n⚠ could not diff the handed-over pre-merge head ${from.slice(0, 7)} to ${after.head_short} — what the pull changed is UNKNOWN, so npm ci runs rather than being skipped: ${(d.stderr || d.stdout || '').trim()}`);
      changed = [];
      dependenciesUnknown = true;
    } else {
      changed = (d.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    }
  }
  if (changed.length) log(`\n${changed.length} file(s) changed ${from.slice(0, 7)}..${after.head_short}`);

  // npm ci only when the dependency set actually moved: it is the one step that
  // needs the network, and it deletes node_modules to do it.
  if (dependenciesUnknown || changed.includes('package-lock.json') || changed.includes('package.json')) {
    if (!step('dependencies moved — npm ci', 'npm', ['ci']).ok) return report;
  }

  // packages/*/dist are gitignored, so every machine builds its own; the hooks/*.mjs,
  // bin/*.mjs, mcp/ and tui/sterling-tui.mjs bundles are COMMITTED (decision
  // sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone, design A),
  // so a consumer must not rebuild them — a rebuild would dirty the tracked bundle, and
  // npm run check verifies the committed ones are fresh instead.
  if (!step('build server + packages (npm run build)', 'npm', ['run', 'build']).ok) return report;
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
  // message told the reader to init the clone — advice that is now wrong. The file
  // plugin.json's `mcpServers` names, .claude-plugin/sterling-mcp.json, is COMMITTED
  // with the plugin (decision
  // sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone) and
  // arrives with the fast-forward itself; init writes nothing into the plugin dir. So
  // a clone with no .sterling/config.json is the NORMAL consumer shape, not a broken
  // one, and nothing is missing when this step is skipped.
  if (existsSync(join(cwd, '.sterling', 'config.json'))) {
    step('re-bake machine artifacts (init ensure pass)', nodeBin, [join(cwd, 'scripts', 'init.mjs'), '--target', cwd, '--update-ensure'], { show: true, tolerate: true });
  } else {
    log(
      '\n▸ re-bake machine artifacts — SKIPPED: no .sterling/config.json in the Sterling clone. That is the NORMAL consumer shape and nothing is missing: the clone-as-project artifacts (its own launchers/CLAUDE.md/agents) are what this step bakes, and the plugin MCP config plugin.json points at is committed and arrived with the fast-forward. Run /sterling:init in a project — not here — if this machine has never done so.',
    );
  }

  // Stamp the consumer role now that the fast-forward + rebuild are complete
  // (todo cabbc10f, decision foreign_a9b98b7d) — running /sterling:update is exactly
  // what a consumer machine does, so a successful run here is the signal.
  // Never fatal: a stamping failure must not make a successful update report
  // as failed.
  stampConsumerRoleIfAbsent(cwd, log);

  // Launchers (sterling.bat, tui.bat, sterling-launch.sh) are baked per project by
  // init, and those baked before the plugin layout name packages/tui/bundle/
  // sterling-tui.mjs, which no longer ships (decision
  // sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone). Nothing
  // in this fan-out re-bakes them, so a consumer is told once. Only a consumer clone
  // reaches this point: the authoring branch above returns before any pull.
  log(`\n▸ launchers — re-run /sterling:init in each Sterling project so its launchers run ${SHIPPED_TUI_BUNDLE} (launchers baked before this version point at ${OLD_TUI_BUNDLE}, which no longer ships).`);
  // S6 (decision s6-consumer-cutover-init-on-installed-copy-fixes-launchers): init run
  // through a --plugin-dir launcher is the CLONE's init and re-bakes the clone launcher,
  // so the route off the clone is named here too.
  log('  To move this machine off the clone instead: run `claude plugin marketplace add Chulf58/sterling` and `claude plugin install sterling@sterling`, then in each project start `claude` directly, not through sterling-launch.sh (its --plugin-dir overrides the installed plugin), and run /sterling:init there. That init replaces the clone launcher, deletes the clone\'s sterling-update.bat, and names this clone for you to delete by hand.');

  // Installed agents are what actually breaks on a pull: template content moves,
  // and the hook commands baked into each project's .claude/agents carry THIS
  // machine's node + hooks paths. A refusal (locally modified agent) is surfaced,
  // never merged, and never stops the other projects.
  // Resolved HERE, not at startup: on a fresh clone the registry cannot be read
  // until the build above has run (see the projects param note).
  const resolvedList = opts.projects === false ? [] : await resolveProjects();
  const registryFailed = resolvedList === null;
  const projectList = resolvedList ?? [];
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
  // The core is complete when everything above succeeded — a red battery, a
  // failed store migration, a failed step, or an unreadable registry (the
  // per-project migrations never ran) leaves it incomplete, and the next run
  // resumes it. The per-project refresh below never decides this.
  const coreComplete = report.exit === 0 && !registryFailed;
  if (registryFailed) fail(2);
  let refreshFailures = 0;
  if (opts.projects !== false && projectList.length) {
    log(`\n▸ syncing agents across ${projectList.length} registered project(s)`);
    refreshFailures = refreshProjects(projectList, { launchers: true });
  } else if (opts.projects === false) {
    log('\n▸ project agent sync — SKIPPED (--no-projects)');
  }

  // Registry coverage — the SAME call the already-current path makes above.
  await reportCoverage(projectList, !registryFailed);
  await reportProjectHygiene(projectList);

  // INSERTS ONLY (user-ruled 2026-10-04 through the question form, "Auto-insert, new text
  // only"): --apply-inserts writes a tracked section or bullet that is entirely absent from
  // a sibling's AGENTS.md/CLAUDE.md and lists what it inserted; without that, text a newer
  // template added never reaches a project initialized before it. Existing wording is
  // reported and never replaced here: the full --apply stays a deliberate act (it rewrites
  // seven repos), and hand-tuned text is still refused.
  // TOLERATED because a sibling's AGENTS.md/CLAUDE.md must never abort THIS clone's update —
  // but tolerated is not the same as unseen: the step's own block sits between
  // build/test/check output, so its verdict is repeated in the closing summary
  // where it cannot scroll past (P1/P5). stamp-contract exits 2 on refusal.
  if (opts.projects !== false && existsSync(join(cwd, 'scripts', 'stamp-contract.mjs'))) {
    const contract = step('contract text in sibling projects (stamp-contract: new text inserted, wording changes reported only)', nodeBin, [join(cwd, 'scripts', 'stamp-contract.mjs'), '--apply-inserts'], {
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

  // Stamp completion ONLY when the CORE completed (board 2b37272a claim A) — a
  // halted step, a red battery or a failed migration leaves it unstamped, so the
  // next behind-0 run resumes the core instead of reporting "Already current".
  // A per-project refresh failure does not withhold it: the refresh runs on
  // every update, so the next run refreshes that project again, loudly. Never
  // fatal: the update itself already succeeded by the time this runs.
  if (registryFailed) {
    log(`\n✗ the project registry could not be read — NO registered project was migrated or refreshed (${registryFailureDetail}). The completion marker is NOT written, so the next /sterling:update reruns the full sequence, per-project store migrations included.`);
  }
  if (coreComplete) {
    try {
      writeUpdateMarker(cwd, after.head);
    } catch (err) {
      log(`\n⚠ update marker write FAILED (nonfatal — the update itself already succeeded): ${err?.message ?? err}`);
    }
    if (refreshFailures) {
      log(`\n✗ the core update is complete, but ${refreshFailures} project(s) failed their refresh (above) — fix them and rerun /sterling:update; every registered project is refreshed on every run.`);
    }
  }

  return report;
}
