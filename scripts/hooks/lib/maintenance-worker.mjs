// BACKGROUND MAINTENANCE WORKER — launcher, runner core and status reader
// (decision maintenance-queue-background-haiku-worker-simple-redesign; the CLI
// behaviour it relies on is finding headless-claude-background-worker-probe-
// september-2026).
//
// WHAT IT DOES. After a commit (H19's Bash surface) or at Stop (H10), when the
// queue holds an open reconcile_needed item that is clean against HEAD and not
// yet judged, the hook calls maybeLaunchMaintenanceWorker. That starts ONE
// detached node runner (scripts/maintenance-worker-run.mjs), which runs a
// headless `claude -p` librarian on Claude Sonnet 5.5 at LOW effort (decision
// point (0)). The child judges each item: already paid -> maintenance_remove
// (the server's attested close checks HEAD); not paid -> an 'owes_prose'
// verdict in its final report. The runner streams the child's output, logs
// every maintenance_remove call and every verdict to a JSONL file, adds the
// run's cost to a per-UTC-day spend, and releases the lock when the child
// exits (or is killed after WORKER_TIMEOUT_MS).
//
// WHY A RUNNER BETWEEN THE HOOK AND claude. The child has no Write or Bash
// grant, so it cannot keep its own log, and a hook cannot wait for it. The
// runner owns the lock for the child's lifetime and records the outcome, so a
// failed, capped or backed-off worker is visible (P5), never a silent skip.
//
// WHAT IT DOES NOT DO: author article prose, create records, edit a queue item,
// or retry a close the server refused. It does not guarantee a verdict is
// right: every close is logged so it can be spot-checked (decision point (6)).
// RESIDUAL: maintenance_remove can remove ANY system item; only the prompt
// limits the worker to reconcile_needed. The JSONL records every call, so a
// stray removal is visible after the fact, not prevented.
//
// DEPENDENCY-FREE (node builtins only): bundled into H1/H10/H19 and imported
// directly by the runner script, so it must not import a workspace package.

import { randomUUID } from 'node:crypto';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_MODEL = 'claude-sonnet-5-5';
export const WORKER_EFFORT = 'low';
export const WORKER_AGENT = 'librarian';
/** Per-run cap passed to --max-budget-usd (lowered to what is left of the day). */
export const WORKER_RUN_BUDGET_USD = 2;
/** Default for config maintenance_worker.daily_budget_usd (per UTC day). */
export const DEFAULT_DAILY_BUDGET_USD = 5;
/** A burst of commits/Stops inside this window starts one worker, not many. */
export const DEBOUNCE_MS = 2 * 60_000;
/** No relaunch this long after a run that failed (error_max_budget included). */
export const BACKOFF_MS = 30 * 60_000;
/** A child still running after this is killed and the run recorded as failed. */
export const WORKER_TIMEOUT_MS = 20 * 60_000;
/** A lock older than this is a crashed or hung runner's leftover. */
export const LOCK_STALE_MS = 30 * 60_000;
/** A takeover mutex older than this belongs to a crashed hook. */
const TAKEOVER_STALE_MS = 60_000;
/** The log and the JSONL rotate to a single .1 backup past this size. */
export const ROTATE_BYTES = 1_000_000;
/** One run's share of maintenance-worker.log; the rest of its stream is
 *  dropped from the log (the JSONL still journals every tool call). */
export const LOG_RUN_CAP_BYTES = 1_000_000;
/** The smallest per-run budget: less than this left today counts as spent. */
export const MIN_RUN_BUDGET_USD = 0.01;
/** Set in the runner's and the child's environment so a Sterling hook that
 *  somehow runs inside them never launches a second worker. */
export const WORKER_ENV_FLAG = 'STERLING_MAINTENANCE_WORKER';
/** Test-run guard: set by scripts/tests/lib/lock-root-isolation.mjs so a
 *  hook spawned by a test against a fixture store never starts a real claude. */
export const WORKER_DISABLE_ENV = 'STERLING_MAINTENANCE_WORKER_DISABLE';
/** The MCP server name the child sees. Tool names follow it. */
const SERVER = 'sterling';
const mcp = (name) => `mcp__${SERVER}__${name}`;
/** Every tool the child may call. dontAsk alone denies MCP calls (probe (B)),
 *  so each is named. Read/Grep are the librarian's own read-only tools; no
 *  Bash, so the child judges from the item, the article and the committed
 *  files rather than from git diffs. */
export const WORKER_TOOLS = [mcp('maintenance_query'), mcp('knowledge_get'), mcp('maintenance_remove'), 'Read', 'Grep'];
/** Denied explicitly, so a project's permissions.allow cannot widen the worker. */
export const WORKER_DISALLOWED_TOOLS = [
  ...['create', 'update', 'append', 'edit', 'array_remove', 'retire', 'supersede', 'split', 'extract', 'promote', 'link'].map((v) => mcp(`knowledge_${v}`)),
  ...['add', 'remove', 'update', 'edit'].map((v) => mcp(`board_${v}`)),
  mcp('config_set'),
  'Write',
  'Edit',
  'Bash',
];

export function workerPaths(root) {
  const sterling = join(root, '.sterling');
  return {
    lock: join(sterling, 'transient', 'maintenance-worker.lock'),
    takeover: join(sterling, 'transient', 'maintenance-worker.lock.takeover'),
    lastLaunch: join(sterling, 'transient', 'maintenance-worker.last-launch'),
    eligible: join(sterling, 'transient', 'maintenance-worker.eligible.json'),
    state: join(sterling, 'transient', 'maintenance-worker.state.json'),
    log: join(sterling, 'maintenance-worker.log'),
    journal: join(sterling, 'maintenance-worker.jsonl'),
  };
}

/** Plugin root: walk up from this module (source: scripts/hooks/lib; bundle:
 *  hooks/) to the directory holding .claude-plugin/plugin.json. */
export function pluginRootFrom(moduleUrl = import.meta.url) {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return { unreadable: String(e?.message ?? e) };
  }
}

/** Rotate `path` to a single `.1` backup once it passes ROTATE_BYTES. */
export function rotateIfLarge(path, limit = ROTATE_BYTES) {
  try {
    if (statSync(path).size > limit) renameSync(path, `${path}.1`);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
}

/** Rotate the JSONL like rotateIfLarge, but carry every still-standing
 *  owes_prose / refused verdict forward into the new file, so a second
 *  rotation can never drop a judgment and relaunch work already judged. */
export function rotateJournal(root, limit = ROTATE_BYTES) {
  const { journal } = workerPaths(root);
  try {
    if (statSync(journal).size <= limit) return;
  } catch (e) {
    if (e?.code === 'ENOENT') return;
    throw e;
  }
  const standing = judgedVerdicts(root);
  renameSync(journal, `${journal}.1`);
  const at = new Date().toISOString();
  // judgedVerdicts holds evidence-backed verdicts only, so only those carry.
  const lines = [...standing].map(([item_id, v]) => JSON.stringify({ at, kind: 'verdict', carried: true, item_id, verdict: v.verdict, file_keys: JSON.parse(v.keys), evidence: true, ...(v.head ? { head: v.head } : {}) }));
  if (lines.length) writeFileSync(journal, lines.join('\n') + '\n');
}

const sortedKeys = (keys) => JSON.stringify([...(keys ?? [])].map(String).sort());

/** item id -> {verdict, keys, head} for its LATEST standing evidence-backed
 *  'owes_prose' or 'refused' verdict, from the JSONL's .1 backup then the
 *  JSONL. A later 'closed' verdict for the id clears it. */
export function judgedVerdicts(root) {
  const { journal } = workerPaths(root);
  const map = new Map();
  for (const path of [`${journal}.1`, journal]) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        continue; // a torn last line from a killed run judges nothing
      }
      if (!v?.item_id || v.kind !== 'verdict') continue;
      // Only an EVIDENCE-BACKED verdict stands (the runner's gate stamps
      // evidence:true). A legacy or gate-failed owes_prose, and an 'unjudged'
      // line, judge nothing and never suppress a relaunch; 'closed' clears.
      if ((v.verdict === 'owes_prose' || v.verdict === 'refused') && v.evidence === true && Array.isArray(v.file_keys)) {
        map.set(v.item_id, { verdict: v.verdict, keys: sortedKeys(v.file_keys), head: v.head ?? null });
      } else if (v.verdict === 'closed') map.delete(v.item_id);
    }
  }
  return map;
}

/** item id -> sorted file_keys of its standing 'owes_prose' verdict. */
export function owesProseVerdicts(root) {
  const out = new Map();
  for (const [id, v] of judgedVerdicts(root)) if (v.verdict === 'owes_prose') out.set(id, v.keys);
  return out;
}

/** Is this item judged 'owes prose' for exactly its CURRENT file_keys? A
 *  re-mint that adds paths makes it launchable again. */
export function isJudgedOwesProse(item, verdicts) {
  return verdicts.get(item.id) === sortedKeys(item.file_keys);
}

/** Is this item judged for its CURRENT state? owes_prose: same file_keys.
 *  refused (a close the server refused): same file_keys AND the same HEAD — a
 *  new commit may make the close attestable, so it becomes launchable again. */
export function isJudged(item, verdicts, head) {
  const v = verdicts.get(item.id);
  if (!v || v.keys !== sortedKeys(item.file_keys)) return false;
  return v.verdict === 'owes_prose' || (v.verdict === 'refused' && Boolean(head) && v.head === head);
}

/** The owning article's slug as the reconcile text names it
 *  ("reconcile article '<slug>' — …"), or null. */
export function articleSlug(item) {
  return /^reconcile article '([^']+)'/.exec(String(item?.text ?? ''))?.[1] ?? null;
}

/** Every open reconcile_needed item, read with the same count-then-capped-query
 *  H1 uses so it can never truncate. */
export function openReconcileItems(store) {
  const total = store.count({ types: ['todo'], source: 'system' });
  if (!total) return [];
  return store.query({ types: ['todo'], source: 'system', cap: total }).filter((t) => t.system_reason === 'reconcile_needed');
}

/** Open reconcile_needed items not judged for their current state. Without a
 *  `head`, a refused verdict never counts as judged (the caller has no HEAD to
 *  compare against). */
export function unjudgedReconcileItems(store, root, head = null) {
  const verdicts = judgedVerdicts(root);
  return openReconcileItems(store).filter((t) => !isJudged(t, verdicts, head));
}

/** HEAD sha and the project root's prefix inside the git top-level (''
 *  when the root IS the top-level), or null when git cannot answer. One call,
 *  no shell. */
export function gitState(root, spawnSync = nodeSpawnSync) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD', '--show-prefix'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const [head, prefix = ''] = String(r.stdout ?? '').split('\n');
  return /^[0-9a-f]{40,64}$/.test(head) ? { head, prefix: prefix.trim() } : null;
}

/** Paths among `paths` (relative to `root`) with uncommitted changes, from
 *  one `git -C <root> status --porcelain -z` call without a shell, or null when
 *  git cannot answer (a spawn error such as E2BIG, a timeout, a non-zero
 *  exit). Porcelain paths are relative to the git top-level, so `prefix` (the
 *  root's place in it, from gitState) is stripped to match file_keys. */
export function dirtyPaths(root, paths, spawnSync = nodeSpawnSync, prefix = '') {
  if (!paths.length) return new Set();
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const dirty = new Set();
  const add = (p) => {
    if (p && p.startsWith(prefix)) dirty.add(p.slice(prefix.length));
  };
  const parts = String(r.stdout ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') add(parts[++i]); // the rename's source path follows
  }
  return dirty;
}

/** Is `pid` a live process? signal 0 probes without delivering: EPERM means it
 *  exists but is not ours to signal. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 'none' | 'live' | 'stale' for the lock file's content. A lock is stale when
 *  its pid is dead, its content is unreadable, or it is older than
 *  LOCK_STALE_MS (a pid can be reused after a WSL restart, so age bounds it). */
export function lockState(lock, nowMs, isAlive = pidAlive) {
  if (!lock) return 'none';
  const started = Date.parse(lock.started_at ?? '');
  if (lock.unreadable || !Number.isFinite(started)) return 'stale';
  if (nowMs - started > LOCK_STALE_MS) return 'stale';
  return isAlive(lock.pid) ? 'live' : 'stale';
}

/**
 * Take the one worker slot atomically. A free slot is an exclusive create
 * ('wx'). A STALE lock is taken over under a mkdir mutex (atomic on every
 * platform): inside it the lock is re-read and re-judged, so two hooks that
 * both saw it stale cannot both remove it — the second finds the first's
 * fresh lock live. The winner re-reads the lock and checks its own token.
 * Returns the token, or null when another process holds the slot.
 */
export function acquireLock(paths, content, nowMs, isAlive = pidAlive) {
  const token = randomUUID();
  const body = JSON.stringify({ ...content, token });
  const tryCreate = () => {
    try {
      writeFileSync(paths.lock, body, { flag: 'wx' });
      return true;
    } catch (e) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  };
  if (!tryCreate()) {
    if (lockState(readJson(paths.lock), nowMs, isAlive) !== 'stale') return null;
    try {
      mkdirSync(paths.takeover);
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(paths.takeover).mtimeMs; // the fs clock is real time, never the injected one
      } catch {
        // vanished: its holder just finished
      }
      if (age > TAKEOVER_STALE_MS) rmdirSync(paths.takeover);
      return null;
    }
    try {
      if (lockState(readJson(paths.lock), nowMs, isAlive) !== 'stale') return null;
      rmSync(paths.lock, { force: true });
      if (!tryCreate()) return null;
    } finally {
      rmdirSync(paths.takeover);
    }
  }
  return readJson(paths.lock)?.token === token ? token : null;
}

/** The Sterling MCP server entry from the plugin's own wiring
 *  (.claude-plugin/sterling-mcp.json, written by init with this machine's node
 *  and clone paths), with ${CLAUDE_PROJECT_DIR} bound to THIS project so the
 *  child reads and writes this project's store — also in a sibling project. */
export function resolveMcpConfig(pluginRoot, projectRoot) {
  const path = join(pluginRoot, '.claude-plugin', 'sterling-mcp.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the plugin MCP wiring ${path} (${e?.code ?? e?.message ?? e}) — run /sterling:init in the clone`);
  }
  const entry = parsed?.mcpServers?.[SERVER];
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    throw new Error(`${path} has no mcpServers.${SERVER} {command, args} entry`);
  }
  const bind = (s) => String(s).split('${CLAUDE_PROJECT_DIR}').join(projectRoot);
  return JSON.stringify({ mcpServers: { [SERVER]: { ...entry, command: bind(entry.command), args: entry.args.map(bind) } } });
}

export function readWorkerPrompt(pluginRoot) {
  const path = join(pluginRoot, 'templates', 'maintenance-worker-prompt.md');
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the worker prompt ${path} (${e?.code ?? e?.message ?? e})`);
  }
}

/** The shipped prompt, plus the ELIGIBLE items the launcher chose (clean,
 *  unjudged) when it passed any, plus every standing judged verdict
 *  (owes_prose, refused) so the child skips those unless they changed. */
export function workerPrompt(pluginRoot, root, eligible = null) {
  let prompt = readWorkerPrompt(pluginRoot);
  if (eligible) {
    prompt +=
      `\nELIGIBLE (judge ONLY these items; every other open item is dirty against HEAD or already judged, so leave it alone):\n` +
      eligible.items.map((t) => `- ${t.id} file_keys ${sortedKeys(t.file_keys)}`).join('\n') +
      '\n';
  }
  const judged = [...judgedVerdicts(root)].map(([id, v]) => `- ${id} ${v.verdict} file_keys ${v.keys}${v.verdict === 'refused' ? ` at HEAD ${v.head}` : ''}`);
  if (judged.length) prompt += `\nALREADY JUDGED (skip each unless its current file_keys differ from the ones listed):\n${judged.join('\n')}\n`;
  return prompt;
}

/** The probed invocation (finding 611f044b), with stream-json output (the CLI
 *  refuses stream-json under -p without --verbose) and an explicit deny list.
 *  No --bare (it ignores OAuth), no bypassPermissions, no --plugin-dir (so no
 *  Sterling hook runs in the child and it cannot recurse). */
export function buildWorkerArgs({ prompt, mcpConfig, budgetUsd = WORKER_RUN_BUDGET_USD }) {
  return [
    '-p',
    prompt,
    '--model',
    WORKER_MODEL,
    '--effort',
    WORKER_EFFORT,
    '--agent',
    WORKER_AGENT,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    WORKER_TOOLS.join(','),
    '--disallowedTools',
    WORKER_DISALLOWED_TOOLS.join(','),
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    String(budgetUsd),
  ];
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function readState(root) {
  const s = readJson(workerPaths(root).state);
  return s && !s.unreadable ? s : { spend: {} };
}

/** USD spent on UTC day `day`, per the runner's state file. */
export function spentOn(state, day) {
  return Number(state?.spend?.[day] ?? 0) || 0;
}

export function dailyBudget(config) {
  const v = Number(config?.maintenance_worker?.daily_budget_usd);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_BUDGET_USD;
}

const LOG_HINT = '(log: .sterling/maintenance-worker.log)';

function failLine(reason) {
  return `⚠ Sterling maintenance worker: launch FAILED (${reason}) — reconcile items stay open; it retries on the next commit or Stop, or drain by hand with /sterling:drain.`;
}

/**
 * Start the worker if one is owed. NEVER throws: every outcome is a result
 * object, and anything the session must see (a failure, an active daily cap or
 * back-off, a failed last run) carries `line`, one line the hook shows.
 *   opts.root       project root (the hook's normalized input.cwd)
 *   opts.config     .sterling/config.json (raw or parsed; null = defaults)
 *   opts.store      an open SterlingStore (or opts.items: the open reconcile items)
 *   opts.trigger    'commit' | 'stop'
 *   opts.spawn      child_process.spawn (injected by tests)
 *   opts.spawnSync  for the git HEAD and dirty checks (injected by tests)
 *   opts.now        Date.now() override; opts.isAlive pid probe override
 *   opts.pluginRoot override; opts.env process.env override
 */
export function maybeLaunchMaintenanceWorker(opts) {
  try {
    const env = opts.env ?? process.env;
    if (env[WORKER_ENV_FLAG] === '1') return { launched: false, reason: 'inside_worker' };
    if (env[WORKER_DISABLE_ENV] === '1') return { launched: false, reason: 'disabled_env' };
    if (opts.config?.maintenance_worker?.enabled === false) return { launched: false, reason: 'disabled' };
    // Cheap filter first (no git): items already judged 'owes prose' for their
    // current file_keys. Refused verdicts need HEAD, checked below.
    const verdicts = judgedVerdicts(opts.root);
    const open = (opts.items ?? openReconcileItems(opts.store)).filter((t) => !isJudged(t, verdicts, null));
    if (open.length === 0) return { launched: false, reason: 'queue_empty' };

    const nowMs = opts.now ?? Date.now();
    const paths = workerPaths(opts.root);
    const state = readState(opts.root);
    const last = state.last_run;
    // A failed run AND a run that made no progress (no evidence-backed verdict,
    // no close) both back off: unjudged items stay eligible, so without this a
    // worker that judges nothing would relaunch at every Stop or commit.
    const stalled = last && (last.ok === false || last.no_progress === true);
    const failedAt = stalled ? Date.parse(last.at ?? '') : NaN;
    if (Number.isFinite(failedAt) && nowMs - failedAt < BACKOFF_MS) {
      const until = new Date(failedAt + BACKOFF_MS).toISOString();
      const what = last.ok === false ? `last run FAILED at ${last.at} (${last.error})` : `worker made no progress in its last run at ${last.at} (0 evidence-backed verdicts, 0 closes)`;
      return { launched: false, reason: 'backoff', line: `⚠ Sterling maintenance worker: ${what} — backing off, no relaunch before ${until} ${LOG_HINT}.` };
    }
    const cap = dailyBudget(opts.config);
    const spent = spentOn(state, utcDay(nowMs));
    // Under a cent left is spent: --max-budget-usd cannot express less.
    if (cap - spent < MIN_RUN_BUDGET_USD) {
      return { launched: false, reason: 'daily_cap', line: `⚠ Sterling maintenance worker: daily budget reached ($${spent.toFixed(2)} of $${cap.toFixed(2)} spent today, UTC) — no launch until 00:00 UTC; raise maintenance_worker.daily_budget_usd or drain with /sterling:drain.` };
    }
    if (lockState(readJson(paths.lock), nowMs, opts.isAlive) === 'live') return { launched: false, reason: 'already_running' };
    const lastLaunch = Number(readJson(paths.lastLaunch)?.at_ms);
    if (Number.isFinite(lastLaunch) && nowMs - lastLaunch < DEBOUNCE_MS) return { launched: false, reason: 'debounced' };

    // A close is attested against HEAD: an item whose files are dirty would only
    // be refused, and a refused verdict stands until HEAD moves. When git cannot
    // answer (not a repo, E2BIG, a timeout) every item counts as dirty: fail
    // closed, never launch blind, and say so.
    const git = gitState(opts.root, opts.spawnSync);
    const dirty = git && dirtyPaths(opts.root, [...new Set(open.flatMap((t) => t.file_keys ?? []))], opts.spawnSync, git.prefix);
    if (!dirty) {
      return { launched: false, reason: 'git_failed', line: `⚠ Sterling maintenance worker: git could not report HEAD or the working-tree state in ${opts.root}, so every reconcile item counts as dirty and no worker starts; drain with /sterling:drain.` };
    }
    const eligible = open.filter((t) => !isJudged(t, verdicts, git.head) && !(t.file_keys ?? []).some((k) => dirty.has(k)));
    if (eligible.length === 0) return { launched: false, reason: 'none_eligible' };

    const pluginRoot = opts.pluginRoot ?? pluginRootFrom();
    if (!pluginRoot) return { launched: false, reason: 'error', line: failLine('plugin root not found above the hook') };
    // Resolve everything the runner needs NOW, so a broken install fails loud
    // in the hook rather than silently in a detached process.
    resolveMcpConfig(pluginRoot, opts.root);
    readWorkerPrompt(pluginRoot);
    const runner = join(pluginRoot, 'scripts', 'maintenance-worker-run.mjs');
    if (!existsSync(runner)) return { launched: false, reason: 'error', line: failLine(`runner missing: ${runner}`) };

    mkdirSync(dirname(paths.lock), { recursive: true });
    const startedAt = new Date(nowMs).toISOString();
    const token = acquireLock(paths, { pid: process.pid, started_at: startedAt, trigger: opts.trigger, stage: 'launching' }, nowMs, opts.isAlive);
    if (!token) return { launched: false, reason: 'already_running' };
    writeFileSync(paths.lastLaunch, JSON.stringify({ at_ms: nowMs, at: startedAt, trigger: opts.trigger }));
    // The child judges ONLY these (PARTIAL 2); the runner checks the token.
    writeFileSync(paths.eligible, JSON.stringify({ token, head: git.head, items: eligible.map((t) => ({ id: t.id, file_keys: t.file_keys ?? [], feature_link: t.feature_link ?? null, slug: articleSlug(t) })) }));

    let logFd;
    try {
      rotateIfLarge(paths.log);
      logFd = openSync(paths.log, 'a');
      const budget = Math.min(WORKER_RUN_BUDGET_USD, Math.round((cap - spent) * 100) / 100);
      const child = opts.spawn(
        process.execPath,
        [runner, '--project', opts.root, '--trigger', String(opts.trigger), '--token', token, '--budget-usd', String(budget)],
        { cwd: opts.root, detached: true, stdio: ['ignore', logFd, logFd], env: { ...env, [WORKER_ENV_FLAG]: '1' } }
      );
      // An async spawn failure (e.g. ENOENT) arrives as 'error' after the hook
      // may have exited; the runner never started, so free the slot.
      child.on?.('error', () => releaseLock(paths, token));
      child.unref?.();
      writeFileSync(paths.lock, JSON.stringify({ pid: child.pid, started_at: startedAt, trigger: opts.trigger, stage: 'running', token }));
      const note = stalled
        ? `ℹ Sterling maintenance worker: the previous run ${last.ok === false ? `FAILED at ${last.at} (${last.error})` : `made no progress at ${last.at}`}; relaunched after the back-off ${LOG_HINT}.`
        : undefined;
      return { launched: true, reason: 'launched', pid: child.pid, items: eligible.length, ...(note ? { line: note } : {}) };
    } catch (e) {
      releaseLock(paths, token);
      return { launched: false, reason: 'error', line: failLine(`spawn: ${e?.message ?? e}`) };
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
  } catch (e) {
    return { launched: false, reason: 'error', line: failLine(e?.message ?? String(e)) };
  }
}

/** Remove the lock only when it still carries `token`. */
export function releaseLock(paths, token) {
  if (readJson(paths.lock)?.token === token) rmSync(paths.lock, { force: true });
}

/** For H1: is a worker running, how did the last run end, today's spend. */
export function workerStatus(root, nowMs = Date.now(), isAlive = pidAlive) {
  const paths = workerPaths(root);
  const lock = readJson(paths.lock);
  const live = lockState(lock, nowMs, isAlive) === 'live';
  const state = readState(root);
  return { running: live, pid: live ? lock.pid : null, since: live ? lock.started_at : null, lastRun: state.last_run ?? null, spentToday: spentOn(state, utcDay(nowMs)) };
}

/** '<n>d <n>h' / '<n>h' / '<n>m' since an ISO timestamp; 'unknown' when it
 *  does not parse. */
export function ageText(iso, nowMs = Date.now()) {
  const ms = nowMs - Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h` : `${mins}m`;
}

/** Verdict lines out of the final result text (the child's JSON-lines report). */
export function parseVerdicts(resultText) {
  const verdicts = [];
  for (const line of String(resultText ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v.verdict === 'string') verdicts.push(v);
    } catch {
      // a non-JSON line in the report is ignored; the run summary says how many parsed
    }
  }
  return verdicts;
}

/**
 * A stream-json consumer: feed() it stdout chunks; it journals every
 * maintenance_remove call with its result as soon as the result arrives (so a
 * killed run still leaves its closes on record) and keeps the final result.
 */
export function streamJournal(journal, observe = () => {}) {
  let buf = '';
  const pending = new Map();
  const out = { result: null, removes: 0, closedOk: 0, lines: 0 };
  const handle = (e) => {
    out.lines++;
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        observe(String(c.name), c.input ?? {});
        if (String(c.name).endsWith('__maintenance_remove')) pending.set(c.id, c.input ?? {});
      }
    } else if (e?.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_result' || !pending.has(c.tool_use_id)) continue;
        const input = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const text = Array.isArray(c.content) ? c.content.map((p) => p?.text ?? '').join('') : String(c.content ?? '');
        journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, is_error: Boolean(c.is_error), result: text.slice(0, 400) });
        out.removes++;
        if (!c.is_error) out.closedOk++;
      }
    } else if (e?.type === 'result') {
      out.result = e;
    }
  };
  const feedLine = (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // a non-JSON line (a CLI warning) is kept in the log only
    }
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        feedLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      feedLine(buf);
      buf = '';
      for (const input of pending.values()) journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, is_error: null, result: 'no result before the run ended' });
      pending.clear();
      return out;
    },
  };
}

/** Did the stream show the child read this item's article AND one of its
 *  files? The article counts by uuid, an 8+ char uuid prefix, or its slug;
 *  a file counts by Read of it or Grep with it as the path. */
export function hasEvidence(item, seenArticles, seenFiles, root) {
  const link = String(item.feature_link ?? '');
  const article = [...seenArticles].some((id) => (link && (id === link || (id.length >= 8 && link.startsWith(id)))) || (item.slug && id === item.slug));
  const file = (item.file_keys ?? []).some((k) => seenFiles.has(resolve(root, k)));
  return article && file;
}

/**
 * The runner's body: run the child on the launcher's ELIGIBLE items, journal
 * every maintenance_remove call and verdict (a refused close becomes a
 * 'refused' verdict keyed by id, file_keys and HEAD), charge the run to
 * today's spend, record the outcome, release the lock. Returns the process
 * exit code. opts: {root, pluginRoot, spawn, now, dryRun, out, log, trigger,
 * token, budgetUsd, claudeBin, timeoutMs, logCapBytes}.
 */
export async function runWorker(opts) {
  const paths = workerPaths(opts.root);
  const nowMs = () => (opts.now ? opts.now() : Date.now());
  const iso = () => new Date(nowMs()).toISOString();
  const log = opts.log ?? ((t) => process.stdout.write(t));
  const bin = opts.claudeBin ?? 'claude';
  const rawBudget = opts.budgetUsd ?? WORKER_RUN_BUDGET_USD;
  const budgetUsd = typeof rawBudget === 'number' ? rawBudget : String(rawBudget).trim() === '' ? NaN : Number(rawBudget);
  const budgetOk = Number.isFinite(budgetUsd) && budgetUsd >= MIN_RUN_BUDGET_USD;
  // The eligible list is the launcher's, bound to this run by the lock token.
  const readEligible = () => {
    const e = readJson(paths.eligible);
    return e && !e.unreadable && e.token === opts.token && Array.isArray(e.items) ? e : null;
  };
  const abs = (p) => (isAbsolute(String(p)) ? resolve(String(p)) : resolve(opts.root, String(p)));
  const buildArgs = (eligible) =>
    buildWorkerArgs({ prompt: workerPrompt(opts.pluginRoot, opts.root, eligible), mcpConfig: resolveMcpConfig(opts.pluginRoot, opts.root), budgetUsd: budgetOk ? budgetUsd : rawBudget });
  if (opts.dryRun) {
    (opts.out ?? console.log)(JSON.stringify({ dry_run: true, cwd: opts.root, command: bin, argv: buildArgs(opts.token ? readEligible() : null) }, null, 2));
    return 0;
  }
  const token = opts.token ?? randomUUID();
  const lock = readJson(paths.lock);
  if (opts.token && lock?.token !== token) {
    log(`maintenance-worker-run: lock token mismatch — another worker holds the slot; not running\n`);
    return 1;
  }
  const runStartMs = nowMs();
  const runId = new Date(runStartMs).toISOString();
  mkdirSync(dirname(paths.lock), { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, started_at: lock?.started_at ?? runId, trigger: opts.trigger, stage: 'running', token }));
  rotateJournal(opts.root);
  const journal = (entry) => appendFileSync(paths.journal, JSON.stringify({ at: iso(), run: runId, ...entry }) + '\n');
  const record = (outcome) => {
    const state = readState(opts.root);
    const spend = { ...(state.spend ?? {}) };
    const day = utcDay(runStartMs);
    const charged = Number(outcome.charged_usd);
    if (Number.isFinite(charged) && charged > 0) spend[day] = Math.round((spentOn(state, day) + charged) * 1e6) / 1e6;
    // keep the last 7 days only
    for (const d of Object.keys(spend).sort().slice(0, -7)) delete spend[d];
    writeFileSync(paths.state, JSON.stringify({ ...state, spend, last_run: { run: runId, trigger: opts.trigger, ...outcome } }));
    journal({ kind: 'run_summary', ...outcome });
  };
  try {
    // A malformed or zero budget is a recorded failure (state written, back-off
    // armed), never a silent exit: nothing ran, so nothing is charged.
    if (!budgetOk) {
      record({ ok: false, at: iso(), error: `invalid --budget-usd '${rawBudget}' (needs a number >= ${MIN_RUN_BUDGET_USD})`, charged_usd: 0 });
      return 1;
    }
    let eligible = null;
    if (opts.token) {
      eligible = readEligible();
      if (!eligible) {
        record({ ok: false, at: iso(), error: 'the eligible-item list is missing or belongs to another launch', charged_usd: 0 });
        return 1;
      }
    }
    let args;
    try {
      args = buildArgs(eligible);
    } catch (e) {
      record({ ok: false, at: iso(), error: e?.message ?? String(e), charged_usd: 0 });
      return 1;
    }
    // A refused close on an eligible item is recorded as a 'refused' verdict
    // keyed by id, file_keys and HEAD, so the launcher skips it until one of
    // them changes (an item the server always refuses must not relaunch the
    // worker at every Stop). A permission denial is not a server refusal.
    const byId = new Map((eligible?.items ?? []).map((t) => [t.id, t]));
    let refusedVerdicts = 0;
    const journalCall = (entry) => {
      journal(entry);
      if (entry.kind === 'tool_call' && entry.is_error === true && byId.has(entry.item_id) && !/permission/i.test(entry.result ?? '')) {
        // The server's refusal IS the evidence for this verdict.
        journal({ kind: 'verdict', item_id: entry.item_id, verdict: 'refused', file_keys: byId.get(entry.item_id).file_keys, head: eligible.head, evidence: true, reason: String(entry.result ?? '').slice(0, 200) });
        refusedVerdicts++;
      }
    };
    // EVIDENCE GATE (P3, not the prompt alone): what the child actually read.
    const seenArticles = new Set();
    const seenFiles = new Set();
    const observe = (name, input) => {
      if (name.endsWith('__knowledge_get') && input.id) seenArticles.add(String(input.id));
      else if (name === 'Read' && input.file_path) seenFiles.add(abs(input.file_path));
      else if (name === 'Grep' && input.path) seenFiles.add(abs(input.path));
    };
    const stream = streamJournal(journalCall, observe);
    const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
    const logCap = opts.logCapBytes ?? LOG_RUN_CAP_BYTES;
    let logged = 0;
    const { code, spawnError, timedOut } = await new Promise((resolve) => {
      let child;
      try {
        child = opts.spawn(bin, args, { cwd: opts.root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, [WORKER_ENV_FLAG]: '1', CLAUDE_PROJECT_DIR: opts.root } });
      } catch (e) {
        resolve({ code: null, spawnError: e, timedOut: false });
        return;
      }
      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill?.('SIGTERM');
        killTimer = setTimeout(() => child.kill?.('SIGKILL'), 10_000);
        killTimer.unref?.();
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        const s = String(d);
        // The log keeps at most logCap bytes of one run's stream; the JSONL
        // journals every tool call regardless.
        if (logged < logCap) {
          const piece = s.slice(0, logCap - logged);
          log(piece);
          logged += piece.length;
          if (logged >= logCap) log(`\n[maintenance-worker-run: log truncated at ${logCap} bytes for this run; the JSONL keeps every tool call]\n`);
        }
        stream.feed(s);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, spawnError: e, timedOut });
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve({ code: c, spawnError: null, timedOut });
      });
    });
    const { result, removes, closedOk } = stream.end();
    if (spawnError) {
      record({ ok: false, at: iso(), error: `could not start ${bin}: ${spawnError.message ?? spawnError}`, charged_usd: 0 });
      return 1;
    }
    const verdicts = parseVerdicts(result?.result);
    let evidenced = 0;
    for (const v of verdicts) {
      if (v.verdict !== 'owes_prose') {
        journal({ kind: 'verdict', ...v });
        continue;
      }
      // An owes_prose verdict stands only when the stream shows the child
      // read BOTH the item's article (knowledge_get) AND one of its files
      // (Read/Grep). Otherwise it is 'unjudged' and suppresses nothing.
      const item = byId.get(v.item_id);
      if (item && hasEvidence(item, seenArticles, seenFiles, opts.root)) {
        journal({ kind: 'verdict', ...v, file_keys: item.file_keys, evidence: true });
        evidenced++;
      } else {
        journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, verdict: 'unjudged', reason: 'no evidence', claimed_reason: v.reason ?? null });
      }
    }
    const denials = Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0;
    const problems = [
      timedOut ? `killed after ${Math.round(timeoutMs / 60_000)} min timeout` : null,
      code !== 0 ? `exit ${code}` : null,
      result ? null : 'no stream-json result event',
      result?.is_error || String(result?.subtype ?? '').startsWith('error') ? `error result (${result?.subtype ?? 'unknown'})` : null,
      denials ? `${denials} permission denial(s)` : null,
    ].filter(Boolean);
    const cost = Number(result?.total_cost_usd);
    // No reported cost (killed, crashed, hung: no result event) is charged the
    // run's whole budget, never $0 — the daily cap must hold when the CLI dies.
    const reported = result && Number.isFinite(cost);
    record({
      ok: problems.length === 0,
      at: iso(),
      error: problems.length ? problems.join('; ') : null,
      verdicts: verdicts.length,
      closed: verdicts.filter((v) => v.verdict === 'closed').length,
      remove_calls: removes,
      closes_ok: closedOk,
      evidenced_verdicts: evidenced,
      // No evidence-backed verdict and no close: back off like a failure.
      refused_verdicts: refusedVerdicts,
      no_progress: evidenced === 0 && closedOk === 0 && refusedVerdicts === 0,
      cost_usd: reported ? cost : null,
      charged_usd: reported ? cost : budgetUsd,
    });
    return problems.length === 0 ? 0 : 1;
  } finally {
    // Release only OUR lock: a stale-lock takeover may have replaced it.
    releaseLock(paths, token);
  }
}
