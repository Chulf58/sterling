// Consumer-machine update core [S] (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89).
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
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// builtins-only module — safe at load time on an unbuilt clone (see the
// bootstrap-independence note in scripts/update.mjs).
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from './update-launcher.mjs';
import { ensureConsumerCheckLauncher, CONSUMER_CHECK_LAUNCHER_NAME } from './consumer-checks.mjs';

// Build + test batteries dominate an update (measured on this machine: build
// ~19s, check ~12s, tests ~87s), so the ceiling is generous — a timeout here
// would abort a healthy update, which is worse than waiting.
const STEP_TIMEOUT_MS = 900_000;

/** Real command runner. Never throws — every caller inspects `status` (P5: no silent path). */
export function defaultExec(cmd, args, { cwd, timeout = STEP_TIMEOUT_MS } = {}) {
  // npm resolves through a .cmd shim on native Windows, which spawn cannot exec
  // directly; the revived native launcher (decision a756e5d9) means this script
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

// Tracked files that are BUILD OUTPUTS, not authored source. hooks/*.mjs are
// committed so git protects the enforcement logic (decision 2422e76a) and
// architecture.md is a projection of the store — both are regenerated by their
// producer and neither is ever hand-edited or pushed FROM a consumer. Keep this
// list in step with what the update refuses to rebuild.
const GENERATED_TRACKED = [/^hooks\/[^/]+\.mjs$/, /^architecture\.md$/];

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
        'COMMITTED BUILD OUTPUTS — discard these, always. They are tracked only so git protects them, and a consumer must never rebuild or push them (the update builds the packages but deliberately skips hooks/). A local rebuild here is not work worth keeping, and discarding cannot hide a defect: `npm run check` rebuilds every hook source into a temp dir and byte-compares it against the committed bundle, so a genuinely wrong bundle fails at the check step instead.\n' +
          `  Run: git checkout -- ${generatedPaths(generated).join(' ')}\n` +
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
 * when the field is ABSENT (todo cabbc10f, decision a9b98b7d). Never
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
    log('\n▸ machine-role stamp — SKIPPED: no .sterling/config.json (run /sterling:init here first)');
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
  const report = { exit: 0, currency: null, steps: [], projects: [], refusal: null };

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

  if (before.behind === 0 && !opts.force) {
    log('\nAlready current — nothing to do. (Rerun with --force to rebuild and re-sync anyway.)');
    return report;
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
  if (opts.test !== false) {
    if (!step('test battery (npm test)', 'npm', ['test']).ok) return report;
  } else {
    log('\n▸ test battery — SKIPPED (--no-test)');
  }

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

  // Re-bake this machine's generated artifacts against the new templates. The
  // ensure pass never overwrites what it cannot prove it generated, so a
  // hand-edited launcher is reported as `differs`, not clobbered.
  if (existsSync(join(cwd, '.sterling', 'config.json'))) {
    step('re-bake machine artifacts (init ensure pass)', nodeBin, [join(cwd, 'scripts', 'init.mjs'), '--target', cwd], { show: true, tolerate: true });
  } else {
    log('\n▸ re-bake machine artifacts — SKIPPED: no .sterling/config.json in the Sterling clone (run /sterling:init here to get launchers + MCP config on this machine)');
  }

  // Stamp the consumer role now that the fast-forward + rebuild are complete
  // (todo cabbc10f, decision a9b98b7d) — running /sterling:update is exactly
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
  if (opts.projects !== false && projectList.length) {
    for (const p of projectList) {
      const projStore = join(p.repo_path, '.sterling', 'sterling.db');
      if (!existsSync(projStore)) continue;
      let projVersion;
      try {
        projVersion = probeSchemaVersion(projStore);
      } catch (err) {
        log(`\n✗ store schema probe FAILED for '${projStore}' — stopping. The fast-forward stands; ${err?.message ?? err}`);
        report.exit = 1;
        return report;
      }
      if (projVersion < 2) {
        if (!step(`migrate store schema v${projVersion} → v2 (${projStore})`, nodeBin, [join(cwd, 'scripts', 'migrate-stores.mjs'), '--db', projStore, '--invoked-by', 'update-sweep'], { show: true }).ok) return report;
        log(`  ▸ migrated: any Sterling session already open on this store must EXIT AND RELAUNCH the Claude Code CLI (a /clear is NOT enough — MCP servers survive it) before it can write again`);
      }
    }
  }
  if (opts.projects !== false && projectList.length) {
    log(`\n▸ syncing agents across ${projectList.length} registered project(s)`);
    for (const p of projectList) {
      const r = exec(nodeBin, [join(cwd, 'scripts', 'sync-agents.mjs'), '--target', p.repo_path], { cwd });
      const out = `${r.stdout}${r.stderr}`.trim();
      const statuses = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+: /.test(l));
      const changedAgents = statuses.filter((l) => !l.startsWith('up_to_date') && !l.startsWith('locally_modified_up_to_date'));
      report.projects.push({ name: p.name, repo_path: p.repo_path, status: r.status, changed: changedAgents.length });
      if (r.status === 2) {
        log(`  ✗ ${p.name}: REFUSED — a locally modified agent. Output verbatim:\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        report.exit = 2;
      } else if (r.status !== 0) {
        log(`  ✗ ${p.name}: sync failed (exit ${r.status}):\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        report.exit = report.exit === 0 ? 1 : report.exit;
      } else {
        log(`  • ${p.name}: ${changedAgents.length ? changedAgents.join(', ') : 'up to date'}`);
      }
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

  // Read-only: reports CLAUDE.md contract drift in sibling projects without
  // touching them (--apply stays a deliberate act — it rewrites seven repos).
  // TOLERATED because a sibling's CLAUDE.md must never abort THIS clone's update —
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
      'RESTART THE SESSION before working: the MCP server and every project subagent load at session start, so the code now on disk is not the code running.'
  );
  return report;
}
