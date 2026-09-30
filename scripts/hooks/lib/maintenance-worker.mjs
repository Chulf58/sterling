// BACKGROUND MAINTENANCE WORKER — launcher, runner core and status reader
// (decision maintenance-queue-background-haiku-worker-simple-redesign; the CLI
// behaviour it relies on is finding headless-claude-background-worker-probe-
// september-2026).
//
// WHAT IT DOES. After a commit (H19's Bash surface) or at Stop (H10), when the
// queue holds an open reconcile_needed item that is clean against HEAD and not
// yet judged, the hook calls maybeLaunchMaintenanceWorker. That starts ONE
// detached node runner (scripts/maintenance-worker-run.mjs), which runs a
// headless `claude -p` librarian on Claude Sonnet 5.5 at MEDIUM effort (decision
// point (0)). The child judges each item: already paid -> maintenance_remove
// (the server's attested close checks HEAD); not paid -> an 'owes_prose'
// verdict in its final report. The runner streams the child's output, logs
// every maintenance_remove call and every verdict to a JSONL file, records the
// run's outcome and cost in its state file, and releases the lock when the child
// exits (or is killed after WORKER_TIMEOUT_MS).
//
// WHY A RUNNER BETWEEN THE HOOK AND claude. The child has no Write or Bash
// grant, so it cannot keep its own log, and a hook cannot wait for it. The
// runner owns the lock for the child's lifetime and records the outcome, so a
// failed or backed-off worker is on record (P5) in the log, the JSONL journal
// and the state file. Nothing is printed at Stop or after a commit; H1 shows
// only a BROKEN last run, once, on its session-start line.
//
// BATCHING: a trigger launches only when BATCH_MIN_ITEMS items are eligible or
// the oldest has waited BATCH_MAX_WAIT_MS; below that the outcome is a quiet,
// logged 'batching' (not a run, so no no_progress and no back-off).
// LINE REFERENCES: the child may repair a moved path:line reference with
// knowledge_line_ref_fix; the runner journals each call; a fix alone is never
// progress (only the close that follows it is). A database-locked
// maintenance_remove is retry-later ('busy'), never a refusal.
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
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_MODEL = 'claude-sonnet-5-5';
export const WORKER_EFFORT = 'medium';
export const WORKER_AGENT = 'librarian';
/** Per-run runaway guard passed to --max-budget-usd on every launch. There is
 *  no daily cap: the worker runs whenever the queue has eligible work (user
 *  ruling 2026-09-30, decision
 *  maintenance-worker-notices-session-start-only-and-no-sliver-launch). */
export const WORKER_RUN_BUDGET_USD = 2;
/** BATCHING (decision maintenance-queue-background-haiku-worker-simple-redesign,
 *  point (2a), user-ruled 2026-09-30): a trigger launches only when at least
 *  this many items are eligible, or the oldest eligible item has waited
 *  BATCH_MAX_WAIT_MS. The audit measured launches for a single item paying the
 *  worker's fixed startup cost for one judgment. */
export const BATCH_MIN_ITEMS = 5;
export const BATCH_MAX_WAIT_MS = 30 * 60_000;
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
/** The smallest --budget-usd the runner accepts: --max-budget-usd cannot
 *  express less, so a smaller (or malformed) value is a recorded failed run. */
export const MIN_RUN_BUDGET_USD = 0.01;
/** A maintenance_remove error that means the store was busy, not that the
 *  server judged the item: retry later. */
const BUSY_RE = /database is locked|SQLITE_BUSY/i;
/** Set in the runner's and the child's environment so a Sterling hook that
 *  somehow runs inside them never launches a second worker. */
export const WORKER_ENV_FLAG = 'STERLING_MAINTENANCE_WORKER';
/** Test-run guard: set by scripts/tests/lib/lock-root-isolation.mjs so a
 *  hook spawned by a test against a fixture store never starts a real claude. */
export const WORKER_DISABLE_ENV = 'STERLING_MAINTENANCE_WORKER_DISABLE';
/** The MCP server name the child sees. Tool names follow it. */
const SERVER = 'sterling';
const mcp = (name) => `mcp__${SERVER}__${name}`;
/** The name the plugin-mounted server gives the same tool. */
const mcpPlugin = (name) => `mcp__plugin_sterling_sterling__${name}`;
/** Every tool the child may call. dontAsk alone denies MCP calls (probe (B)),
 *  so each is named. Read/Grep are the librarian's own read-only tools; no
 *  Bash, so the child judges from the item, the article and the committed
 *  files rather than from git diffs. knowledge_line_ref_fix is the one article
 *  write it gets (decision point (3a)): the server checks the new line at HEAD
 *  contains the anchor and changes nothing else, so it can only move a
 *  path:line reference. Both mounted names are allowed. */
export const WORKER_TOOLS = [mcp('maintenance_query'), mcp('knowledge_get'), mcp('maintenance_remove'), mcp('knowledge_line_ref_fix'), mcpPlugin('knowledge_line_ref_fix'), 'Read', 'Grep'];
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

export function readState(root) {
  const s = readJson(workerPaths(root).state);
  return s && !s.unreadable ? s : {};
}

/** The one state writer: the state file holds the last run only (a legacy
 *  per-day `spend` map from the removed daily cap is dropped by this rewrite).
 *  Used by runWorker for a finished run and by the launcher for a failure to
 *  start, so H1 and the back-off see both the same way. */
function writeLastRun(root, lastRun) {
  const { state } = workerPaths(root);
  mkdirSync(dirname(state), { recursive: true });
  writeFileSync(state, JSON.stringify({ last_run: lastRun }));
}

/** Append one line about a launcher outcome to maintenance-worker.log. The
 *  launcher's outcomes are never printed by a hook: this log is where a
 *  back-off or a failed launch is on record (P5). */
function logLauncherNote(root, reason, detail) {
  const { log } = workerPaths(root);
  mkdirSync(dirname(log), { recursive: true });
  rotateIfLarge(log);
  appendFileSync(log, `maintenance-worker: ${new Date().toISOString()} ${reason}: ${detail}\n`);
}

function failDetail(reason) {
  return `launch FAILED (${reason}) — reconcile items stay open; it retries after the 30-minute back-off, or drain by hand with /sterling:drain.`;
}

/**
 * Start the worker if one is owed. NEVER throws: every outcome is a result
 * object. The result carries no text for the hook to show: a back-off, a git
 * failure or a failed launch has a `detail` string that is appended to
 * maintenance-worker.log (and returned for tests), and nothing else. If that
 * log write itself fails, the result says so in `log_error`.
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
  const result = launchWorker(opts);
  if (result.detail) {
    let logError = null;
    try {
      logLauncherNote(opts.root, result.reason, result.detail);
    } catch (e) {
      logError = e?.message ?? String(e);
      result.log_error = logError;
    }
    // A failure to START (git cannot answer, a broken install, a spawn error)
    // is a failed last run: H1 names it (workerBreakage) and the back-off stops
    // a retry at every Stop. A back-off note is not a new failure. If the log
    // could not be written, that is folded into the recorded error.
    if (result.reason === 'git_failed' || result.reason === 'error') {
      try {
        writeLastRun(opts.root, {
          trigger: opts.trigger,
          ok: false,
          at: new Date(opts.now ?? Date.now()).toISOString(),
          error: logError ? `${result.detail}; could not write maintenance-worker.log (${logError})` : result.detail,
        });
      } catch (e) {
        result.log_error = [result.log_error, `could not record last_run: ${e?.message ?? e}`].filter(Boolean).join('; ');
      }
    }
  }
  return result;
}

function launchWorker(opts) {
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
      return { launched: false, reason: 'backoff', detail: `${what} — backing off, no relaunch before ${until}` };
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
      return { launched: false, reason: 'git_failed', detail: `git could not report HEAD or the working-tree state in ${opts.root}, so every reconcile item counts as dirty and no worker starts; drain with /sterling:drain.` };
    }
    const eligible = open.filter((t) => !isJudged(t, verdicts, git.head) && !(t.file_keys ?? []).some((k) => dirty.has(k)));
    if (eligible.length === 0) return { launched: false, reason: 'none_eligible' };
    // BATCHING. The wait is measured from the item's created_at: it is the one
    // timestamp the launcher already holds for every item (a "last became
    // eligible" time would need new state), and an item that sat dirty then went
    // clean HAS been waiting, so it does not wait again. An item with no usable
    // created_at counts as already waited, so the batch check can never strand
    // work it cannot date. This sits after back-off, lock and debounce and
    // before the lock is taken: a batching result changes no state.
    const waited = (t) => {
      const created = Date.parse(t.created_at ?? '');
      return Number.isFinite(created) ? nowMs - created : Infinity;
    };
    const oldestWaitMs = Math.max(...eligible.map(waited));
    if (eligible.length < BATCH_MIN_ITEMS && oldestWaitMs < BATCH_MAX_WAIT_MS) {
      return {
        launched: false,
        reason: 'batching',
        detail: `${eligible.length} of ${BATCH_MIN_ITEMS} eligible reconcile items, oldest waited ${ageText(new Date(nowMs - oldestWaitMs).toISOString(), nowMs)} of ${Math.round(BATCH_MAX_WAIT_MS / 60_000)}m — no worker until ${BATCH_MIN_ITEMS} are eligible or the oldest has waited that long`,
      };
    }

    const pluginRoot = opts.pluginRoot ?? pluginRootFrom();
    if (!pluginRoot) return { launched: false, reason: 'error', detail: failDetail('plugin root not found above the hook') };
    // Resolve everything the runner needs NOW, so a broken install fails loud
    // in the hook rather than silently in a detached process.
    resolveMcpConfig(pluginRoot, opts.root);
    readWorkerPrompt(pluginRoot);
    const runner = join(pluginRoot, 'scripts', 'maintenance-worker-run.mjs');
    if (!existsSync(runner)) return { launched: false, reason: 'error', detail: failDetail(`runner missing: ${runner}`) };

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
      const child = opts.spawn(
        process.execPath,
        [runner, '--project', opts.root, '--trigger', String(opts.trigger), '--token', token, '--budget-usd', String(WORKER_RUN_BUDGET_USD)],
        { cwd: opts.root, detached: true, stdio: ['ignore', logFd, logFd], env: { ...env, [WORKER_ENV_FLAG]: '1' } }
      );
      // An async spawn failure (e.g. ENOENT) arrives as 'error' after the hook
      // may have exited; the runner never started, so free the slot.
      child.on?.('error', () => releaseLock(paths, token));
      child.unref?.();
      writeFileSync(paths.lock, JSON.stringify({ pid: child.pid, started_at: startedAt, trigger: opts.trigger, stage: 'running', token }));
      return { launched: true, reason: 'launched', pid: child.pid, items: eligible.length };
    } catch (e) {
      releaseLock(paths, token);
      return { launched: false, reason: 'error', detail: failDetail(`spawn: ${e?.message ?? e}`) };
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
  } catch (e) {
    return { launched: false, reason: 'error', detail: failDetail(e?.message ?? String(e)) };
  }
}

/** Remove the lock only when it still carries `token`. */
export function releaseLock(paths, token) {
  if (readJson(paths.lock)?.token === token) rmSync(paths.lock, { force: true });
}

/** For H1: is a worker running, and how did the last run end. */
export function workerStatus(root, nowMs = Date.now(), isAlive = pidAlive) {
  const paths = workerPaths(root);
  const lock = readJson(paths.lock);
  const live = lockState(lock, nowMs, isAlive) === 'live';
  const state = readState(root);
  return { running: live, pid: live ? lock.pid : null, since: live ? lock.started_at : null, lastRun: state.last_run ?? null };
}

/** The reason a recorded run was BROKEN, or null for a routine run. runWorker
 *  sets ok:false, with the reasons in `error`, for a non-zero exit, an error
 *  result (is_error or an error subtype), permission denials, an MCP server
 *  that is not connected, a timeout, a missing result event and a run that
 *  could not start. A back-off, nothing eligible and no_progress with no error
 *  are routine and give null. H1 shows this once; no hook prints it otherwise. */
export function workerBreakage(lastRun) {
  if (!lastRun || lastRun.ok !== false) return null;
  return { at: lastRun.at ?? 'unknown time', reason: lastRun.error ? String(lastRun.error) : 'unknown error' };
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

/** Is the MCP server status from the init event breakage? Only an explicit
 *  failed or disconnected status, or any other non-connected status (pending,
 *  needs-auth, absent from the list) when no sterling tool call succeeded in the
 *  stream. A 'pending' snapshot at init that the run then used is unknown, not
 *  broken. null status (never reported) is unknown. */
export function mcpBroken(status, sterlingOk) {
  if (status === null || status === 'connected') return false;
  return status === 'failed' || status === 'disconnected' || sterlingOk === 0;
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
 * `observe(name, input)` fires for every OTHER tool call only when its
 * tool_result arrives WITHOUT is_error (paired by tool_use_id), so a call that
 * failed is never evidence. `launchKeys` maps item id -> the file_keys the
 * runner snapshotted into eligible.json at launch; each maintenance_remove line
 * carries them as `item_file_keys_at_launch` (the tool's result does not echo
 * the removed item's own file_keys).
 */
export function streamJournal(journal, observe = () => {}, launchKeys = new Map()) {
  // null means the child removed an item it was not offered (not in eligible.json).
  const keysAtLaunch = (id) => launchKeys.get(id) ?? null;
  let buf = '';
  const pending = new Map();
  const calls = new Map();
  const out = { result: null, removes: 0, closedOk: 0, lineRefFixes: 0, lineRefFixesOk: 0, lines: 0, mcpStatus: null, sterlingOk: 0 };
  const isFix = (name) => String(name).endsWith('__knowledge_line_ref_fix');
  const fixEntry = (input, is_error, result) => ({ kind: 'tool_call', tool: 'knowledge_line_ref_fix', article_id: input.id ?? null, field: input.field ?? null, find: input.find ?? null, replace: input.replace ?? null, anchor: input.anchor ?? null, is_error, result });
  const handle = (e) => {
    out.lines++;
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        if (String(c.name).endsWith('__maintenance_remove')) pending.set(c.id, { fix: false, input: c.input ?? {} });
        else if (isFix(c.name)) pending.set(c.id, { fix: true, input: c.input ?? {} });
        else calls.set(c.id, { name: String(c.name), input: c.input ?? {} });
      }
    } else if (e?.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        if (calls.has(c.tool_use_id)) {
          const call = calls.get(c.tool_use_id);
          calls.delete(c.tool_use_id);
          if (!c.is_error) {
            if (call.name.startsWith(`mcp__${SERVER}__`)) out.sterlingOk++;
            observe(call.name, call.input);
          }
          continue;
        }
        if (!pending.has(c.tool_use_id)) continue;
        const { fix, input } = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const text = Array.isArray(c.content) ? c.content.map((p) => p?.text ?? '').join('') : String(c.content ?? '');
        if (fix) {
          // A refused fix is the tool doing its job, not an error of the run.
          journal(fixEntry(input, Boolean(c.is_error), text.slice(0, 400)));
          out.lineRefFixes++;
          if (!c.is_error) {
            out.lineRefFixesOk++;
            out.sterlingOk++;
          }
          continue;
        }
        journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error: Boolean(c.is_error), result: text.slice(0, 400) });
        out.removes++;
        if (!c.is_error) {
          out.closedOk++;
          out.sterlingOk++;
        }
      }
    } else if (e?.type === 'result') {
      out.result = e;
    } else if (e?.type === 'system' && e.subtype === 'init' && Array.isArray(e.mcp_servers)) {
      // The init event lists each MCP server's connection status; a listing
      // without ours means it was never configured or loaded.
      out.mcpStatus = String(e.mcp_servers.find((m) => m?.name === SERVER)?.status ?? 'missing');
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
      for (const { fix, input } of pending.values()) {
        journal(fix ? fixEntry(input, null, 'no result before the run ended') : { kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error: null, result: 'no result before the run ended' });
      }
      pending.clear();
      return out;
    },
  };
}

/** Did the stream show the child SUCCESSFULLY read this item's article AND
 *  one of its files? The article counts by uuid, an 8+ char uuid prefix, or
 *  its slug. A file counts by a Read of it (`seenFiles`), or by a Grep whose
 *  path is that file or a directory containing it (`seenGrepPaths`; a Grep
 *  with no path searched the project root) — conductor ruling 2026-09-29. */
export function hasEvidence(item, seenArticles, seenFiles, root, seenGrepPaths = new Set()) {
  const link = String(item.feature_link ?? '');
  const article = [...seenArticles].some((id) => (link && (id === link || (id.length >= 8 && link.startsWith(id)))) || (item.slug && id === item.slug));
  const file = (item.file_keys ?? []).some((k) => {
    const target = resolve(root, k);
    if (seenFiles.has(target)) return true;
    for (const g of seenGrepPaths) if (target === g || target.startsWith(g.endsWith(sep) ? g : g + sep)) return true;
    return false;
  });
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
    writeLastRun(opts.root, { run: runId, trigger: opts.trigger, ...outcome });
    journal({ kind: 'run_summary', ...outcome });
  };
  try {
    // A malformed or zero budget is a recorded failure (state written, back-off
    // armed), never a silent exit.
    if (!budgetOk) {
      record({ ok: false, at: iso(), error: `invalid --budget-usd '${rawBudget}' (needs a number >= ${MIN_RUN_BUDGET_USD})` });
      return 1;
    }
    let eligible = null;
    if (opts.token) {
      eligible = readEligible();
      if (!eligible) {
        record({ ok: false, at: iso(), error: 'the eligible-item list is missing or belongs to another launch' });
        return 1;
      }
    }
    let args;
    try {
      args = buildArgs(eligible);
    } catch (e) {
      record({ ok: false, at: iso(), error: e?.message ?? String(e) });
      return 1;
    }
    // A refused close on an eligible item is recorded as a 'refused' verdict
    // keyed by id, file_keys and HEAD, so the launcher skips it until one of
    // them changes (an item the server always refuses must not relaunch the
    // worker at every Stop). A permission denial is not a server refusal.
    const byId = new Map((eligible?.items ?? []).map((t) => [t.id, t]));
    // What was already refused for an item's current file_keys BEFORE this run:
    // refusing it again is not information, so it is not progress (else an item
    // the server always refuses would relaunch at every new HEAD with no back-off).
    const standing = judgedVerdicts(opts.root);
    const repeatRefusal = (id) => {
      const v = standing.get(id);
      return Boolean(v) && v.verdict === 'refused' && v.keys === sortedKeys(byId.get(id)?.file_keys);
    };
    let refusedVerdicts = 0;
    let newRefusals = 0;
    let busyCalls = 0;
    const journalCall = (entry) => {
      journal(entry);
      if (entry.kind === 'tool_call' && entry.tool === 'maintenance_remove' && entry.is_error === true && BUSY_RE.test(entry.result ?? '')) {
        // A locked store is retry-later, not the server's judgment: no 'refused'
        // verdict, no evidence stamp, so judgedVerdicts ignores it and the item
        // stays eligible for a later run.
        busyCalls++;
        if (byId.has(entry.item_id)) journal({ kind: 'verdict', item_id: entry.item_id, verdict: 'busy', reason: String(entry.result ?? '').slice(0, 200) });
      } else if (entry.kind === 'tool_call' && entry.is_error === true && byId.has(entry.item_id) && !/permission/i.test(entry.result ?? '')) {
        // The server's refusal IS the evidence for this verdict.
        journal({ kind: 'verdict', item_id: entry.item_id, verdict: 'refused', file_keys: byId.get(entry.item_id).file_keys, head: eligible.head, evidence: true, reason: String(entry.result ?? '').slice(0, 200) });
        refusedVerdicts++;
        if (!repeatRefusal(entry.item_id)) newRefusals++;
      }
    };
    // EVIDENCE GATE (P3, not the prompt alone): what the child actually read.
    // Fed only by calls whose result came back without an error.
    const seenArticles = new Set();
    const seenFiles = new Set();
    const seenGrepPaths = new Set();
    const observe = (name, input) => {
      if (name.endsWith('__knowledge_get') && input.id) seenArticles.add(String(input.id));
      else if (name === 'Read' && input.file_path) seenFiles.add(abs(input.file_path));
      else if (name === 'Grep') seenGrepPaths.add(input.path ? abs(input.path) : resolve(opts.root));
    };
    const stream = streamJournal(journalCall, observe, new Map([...byId].map(([id, t]) => [id, t.file_keys ?? []])));
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
    const { result, removes, closedOk, lineRefFixes, lineRefFixesOk, mcpStatus, sterlingOk } = stream.end();
    if (spawnError) {
      record({ ok: false, at: iso(), error: `could not start ${bin}: ${spawnError.message ?? spawnError}` });
      return 1;
    }
    const verdicts = parseVerdicts(result?.result);
    let evidenced = 0;
    for (const v of verdicts) {
      if (v.verdict !== 'owes_prose') {
        // Only the allowed fields are copied from the child: evidence, head and
        // file_keys are the runner's to set. A 'refused' verdict comes only
        // from the runner's own stream observation, never from the child.
        if (v.verdict === 'refused') {
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, verdict: 'unjudged', reason: 'a refused verdict is recorded by the runner, not the child', claimed_reason: v.reason ?? null });
        } else {
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, verdict: v.verdict, reason: v.reason ?? null });
        }
        continue;
      }
      // An owes_prose verdict stands only when the stream shows the child
      // read BOTH the item's article (knowledge_get) AND one of its files
      // (Read/Grep). Otherwise it is 'unjudged' and suppresses nothing.
      const item = byId.get(v.item_id);
      if (item && hasEvidence(item, seenArticles, seenFiles, opts.root, seenGrepPaths)) {
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
      mcpBroken(mcpStatus, sterlingOk) ? `MCP server '${SERVER}' not connected (${mcpStatus}${mcpStatus === 'failed' || mcpStatus === 'disconnected' ? '' : '; no successful sterling tool call'})` : null,
    ].filter(Boolean);
    const cost = Number(result?.total_cost_usd);
    // No reported cost (killed, crashed, hung: no result event) records null,
    // never a made-up $0.
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
      // No evidence-backed verdict, no close and no NEW refusal: back off like a
      // failure. A line-reference fix is NEVER progress on its own: the server
      // accepts a shift back and forth (2->4, then 4->2) when both lines hold the
      // anchor, so counting fixes would loop a $2 run at every trigger. A run that
      // fixes and then closes counts through closes_ok; a refused close through
      // newRefusals. A locked-database remove is none of these: a run that only
      // hit the lock backs off, which is the retry delay.
      refused_verdicts: refusedVerdicts,
      busy_calls: busyCalls,
      line_ref_fixes: lineRefFixes,
      line_ref_fixes_ok: lineRefFixesOk,
      no_progress: evidenced === 0 && closedOk === 0 && newRefusals === 0,
      cost_usd: reported ? cost : null,
      // The MCP server's status from the stream's init event (null: never
      // reported); mcpBroken says when it counts as breakage.
      mcp_status: mcpStatus,
    });
    return problems.length === 0 ? 0 : 1;
  } finally {
    // Release only OUR lock: a stale-lock takeover may have replaced it.
    releaseLock(paths, token);
  }
}
