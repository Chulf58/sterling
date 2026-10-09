// BACKGROUND MAINTENANCE WORKER — launcher, runner core and status reader
// (decision maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet,
// GitHub #56; the CLI behaviour it relies on is finding
// headless-claude-background-worker-probe-september-2026).
//
// WHAT IT DOES. After a commit (H19's Bash surface) or at Stop (H10), when the
// queue holds open items in the worker's lanes (WORKER_LANES) that are clean
// against HEAD and not yet judged, the hook calls maybeLaunchMaintenanceWorker.
// That starts ONE detached node runner (scripts/maintenance-worker-run.mjs),
// which runs a headless `claude -p` librarian on Claude Sonnet 5.5 at MEDIUM
// effort over a bounded, lane-fair batch. The child closes already-paid items
// (maintenance_remove, or resolves on its completing write), writes the small
// factual refresh itself (files[], entry marks, state, source_date, one
// corrected sentence) and hands every item that needs a ruling or new prose to
// the conductor as a 'needs_conductor' verdict with a reason. The runner
// streams the child's output, journals every write and close and every
// verdict to a JSONL file, records the run's outcome and cost in its state
// file, releases the lock when the child exits (or is killed after
// WORKER_TIMEOUT_MS), and starts the next run itself while runs make progress.
//
// WHY A RUNNER BETWEEN THE HOOK AND claude. The child has no Write or Bash
// grant, so it cannot keep its own log, and a hook cannot wait for it. The
// runner owns the lock for the child's lifetime and records the outcome, so a
// failed or backed-off worker is on record (P5) in the log, the JSONL journal
// and the state file. Nothing is printed at Stop or after a commit; H1 shows
// only a BROKEN last run, once, on its session-start line.
//
// AUTHORIZATION. The batch policy is eligible.json (token-bound). The
// launcher writes it, and the per-run MCP config hands its path and the lock
// token to the worker's own Sterling server as argv (--worker-policy,
// --worker-token), which checks every mutation before it runs. The stream
// parser here only observes: a successful knowledge_* write whose receipt
// lacks this run's stamp (STAMP_KEY) fails the run as an unpoliced write.
//
// BATCHING: a trigger launches only when BATCH_MIN_ITEMS items are eligible or
// the oldest has waited BATCH_MAX_WAIT_MS; below that the outcome is a quiet,
// logged 'batching' (not a run, so no no_progress and no back-off). One run
// takes at most RUN_BATCH_MAX items, round-robin across lanes, oldest first.
// CHAINING: a run that closed or fixed an item and left eligible work starts
// the launcher again; lock, debounce and back-off still apply.
// LINE REFERENCES: the child may repair a moved path:line reference with
// knowledge_line_ref_fix; a fix alone is never progress (the server accepts a
// shift back and forth). A database-locked maintenance_remove is retry-later
// ('busy'), never a refusal.
//
// OPENCODE HOST (board item Parity P8): on a machine without `claude`, the
// OpenCode plugin launches with host 'opencode'; the runner then runs `opencode
// run` (maintenance-worker-opencode.mjs), whose event parser feeds the same
// journal, stamp check and evidence gate.
//
// WHAT IT DOES NOT DO: create, retire, supersede, split or link records, write
// behaviour prose beyond one corrected sentence, or retry a close the server
// refused. It does not guarantee an edit is right: every write is stamped and
// journalled, and H1 shows the journal count for a sample spot check
// (decision point (4)).
//
// DEPENDENCY-FREE (node builtins only): bundled into H1/H10/H19 and imported
// directly by the runner script, so it must not import a workspace package.

import { randomUUID } from 'node:crypto';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpencodeArgs, buildOpencodeConfig, opencodeEnv, opencodePrompt, opencodeStreamJournal } from './maintenance-worker-opencode.mjs';

/** Sonnet 5.5, not Haiku: the worker writes factual edits, and an unreviewed
 *  wrong edit makes the store lie (decision
 *  maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet,
 *  user ruling (2)). */
export const WORKER_MODEL = 'claude-sonnet-5-5';
export const WORKER_EFFORT = 'medium';
export const WORKER_AGENT = 'librarian';
/** Per-run runaway guard passed to --max-budget-usd on every launch. There is
 *  no daily cap: the worker runs whenever the queue has eligible work (same
 *  decision, design (g) and ruling (5)). A run that reaches it after making
 *  progress is a normal bounded end, not a failure (change (vi)). */
export const WORKER_RUN_BUDGET_USD = 5;
/** The queue lanes the worker drains (user ruling (1)). Every other lane is
 *  the conductor's. */
export const WORKER_LANES = ['reconcile_needed', 'state_review', 'stale_research', 'refresh_reference', 'article_missing'];
/** One run takes at most this many items, picked round-robin across lanes and
 *  oldest first within a lane (design (g)); the rest wait for the next run. */
export const RUN_BATCH_MAX = 12;
/** BATCHING (user-ruled 2026-09-30): a trigger launches only when at least
 *  this many items are eligible, or the oldest eligible item has waited
 *  BATCH_MAX_WAIT_MS. The audit measured launches for a single item paying the
 *  worker's fixed startup cost for one judgment. */
export const BATCH_MIN_ITEMS = 5;
export const BATCH_MAX_WAIT_MS = 30 * 60_000;
/** The receipt key the worker's Sterling server stamps on every allowed write,
 *  {run_id, item_id} (change (i)). The server side names the key; adjust it
 *  here if it differs. */
export const STAMP_KEY = 'worker_stamp';
/** eligible.json's policy shape version (change (ii)). */
export const POLICY_VERSION = 1;
/** Capability marker on every verdict line this worker writes. A
 *  needs_conductor verdict stands only with it, so an owes_prose verdict from
 *  the judge-only worker is judged once more under the write grant (change
 *  (ix)); rotation carries the marker forward. */
export const WORKER_CAPABILITY = 'factual_refresh_v1';
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
 *  so each is named. Read/Grep are the librarian's own read-only tools and
 *  WebSearch/WebFetch re-check stale_research and refresh_reference claims
 *  (user ruling (3)); no Bash, so the child judges from the item, the record
 *  and the committed files rather than from git diffs. The update-shaped
 *  knowledge writes are granted for the small factual refresh (ruling (1),
 *  design (c)); the worker's own Sterling server limits each one to the batch
 *  policy before it runs. knowledge_line_ref_fix can only move a path:line
 *  reference. Both mounted names are allowed for the writes and the new reads. */
const WRITE_GRANT = ['knowledge_update', 'knowledge_edit', 'knowledge_append', 'knowledge_array_remove'];
export const WORKER_TOOLS = [
  mcp('maintenance_query'),
  mcp('knowledge_get'),
  mcp('maintenance_remove'),
  mcp('knowledge_line_ref_fix'),
  mcpPlugin('knowledge_line_ref_fix'),
  ...[...WRITE_GRANT, 'knowledge_query', 'knowledge_schema'].flatMap((t) => [mcp(t), mcpPlugin(t)]),
  'Read',
  'Grep',
  'WebSearch',
  'WebFetch',
];
/** Denied explicitly, so a project's permissions.allow cannot widen the worker
 *  (ruling (3), design (c)): every record-shaping write, every board write,
 *  config and domain writes, and shell and file writes. */
export const WORKER_DISALLOWED_TOOLS = [
  ...['create', 'retire', 'supersede', 'split', 'extract', 'promote', 'link'].map((v) => mcp(`knowledge_${v}`)),
  ...['add', 'remove', 'update', 'edit'].map((v) => mcp(`board_${v}`)),
  mcp('config_set'),
  mcp('domain_describe'),
  'Write',
  'Edit',
  'Bash',
];
/** Short names of the knowledge writes whose successful receipt must carry this
 *  run's stamp. The denied ones are listed too: if one ever succeeded, it is
 *  an unpoliced write. */
export const KNOWLEDGE_WRITE_TOOLS = [...WRITE_GRANT, 'knowledge_line_ref_fix', 'knowledge_create', 'knowledge_retire', 'knowledge_supersede', 'knowledge_split', 'knowledge_extract', 'knowledge_promote', 'knowledge_link'];

/** The two runner hosts (board item Parity P8). The launcher records the one its
 *  caller chose in eligible.json; H1/H10/H19 run on Claude Code and pass none,
 *  which is 'claude'. The OpenCode plugin passes 'opencode' when `claude` is
 *  not on PATH. */
export const WORKER_HOSTS = ['claude', 'opencode'];
/** Config key (in maintenance_worker) naming the OpenCode runner's model as
 *  provider/model. It is a config choice because Anthropic OAuth through
 *  OpenCode bills as extra usage (finding
 *  opencode-2-plugin-spike-hooks-and-sidebar-october-2026). Unset, the OpenCode
 *  runner REFUSES and never falls back to OpenCode's default model (user-ruled,
 *  decision opencode-maintenance-worker-refuses-without-a-configured-model). */
export const OPENCODE_MODEL_KEY = 'opencode_model';
/** Is a usable OpenCode model configured? (`config` raw or parsed, as the launcher takes it.) */
export const opencodeModelOf = (config) => config?.maintenance_worker?.[OPENCODE_MODEL_KEY] ?? null;
export const OPENCODE_MODEL_UNSET =
  `config maintenance_worker.${OPENCODE_MODEL_KEY} is not set, so the OpenCode maintenance worker does not start (it never falls back to OpenCode's default model). Set it to a provider/model in .sterling/config.json, or drain by hand with /sterling:drain`;

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
 *  needs_conductor / refused verdict forward into the new file, with its
 *  reason, lane and capability marker, so a second rotation can never drop a
 *  judgment or a handoff reason and relaunch work already judged. */
export function rotateJournal(root, limit = ROTATE_BYTES) {
  const { journal } = workerPaths(root);
  try {
    if (statSync(journal).size <= limit) return;
  } catch (e) {
    if (e?.code === 'ENOENT') return;
    throw e;
  }
  const standing = judgedVerdicts(root);
  // The old backup is about to be replaced, so its write count is carried.
  const writes = { count: countWrites(journalLines(root, [`${journal}.1`])) };
  renameSync(journal, `${journal}.1`);
  const at = new Date().toISOString();
  // judgedVerdicts holds evidence-backed verdicts only, so only those carry.
  const lines = [...standing].map(([item_id, v]) =>
    JSON.stringify({
      at,
      kind: 'verdict',
      carried: true,
      item_id,
      verdict: v.verdict,
      file_keys: JSON.parse(v.keys),
      evidence: true,
      ...(v.head ? { head: v.head } : {}),
      ...(v.lane ? { lane: v.lane } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.capability ? { capability: v.capability } : {}),
    })
  );
  // The sample-audit count survives too: the .1 backup is the one older file
  // kept, so this rotation would otherwise lose the replaced backup's count.
  if (writes.count) lines.push(JSON.stringify({ at, kind: 'writes_carried', count: writes.count }));
  if (lines.length) writeFileSync(journal, lines.join('\n') + '\n');
}

const sortedKeys = (keys) => JSON.stringify([...(keys ?? [])].map(String).sort());

/** The JSONL then its .1 backup's parsed lines, oldest first; a torn line (a
 *  killed run) is skipped. */
function journalLines(root, files = null) {
  const { journal } = workerPaths(root);
  const out = [];
  for (const path of files ?? [`${journal}.1`, journal]) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn last line from a killed run judges nothing
      }
    }
  }
  return out;
}

/** item id -> {verdict, keys, head, reason, lane, capability} for its LATEST
 *  standing verdict, from the JSONL's .1 backup then the JSONL. Standing:
 *  an evidence-backed 'needs_conductor' that carries WORKER_CAPABILITY, or an
 *  evidence-backed 'refused'. A legacy 'owes_prose' (the judge-only worker's,
 *  no marker) does not stand, so that item is judged once more under the write
 *  grant (change (ix)). A later 'closed' verdict for the id clears it. */
export function judgedVerdicts(root) {
  const map = new Map();
  for (const v of journalLines(root)) {
    if (!v?.item_id || v.kind !== 'verdict') continue;
    // Only an EVIDENCE-BACKED verdict stands (the runner's gate stamps
    // evidence:true). A gate-failed verdict, an 'unjudged' or a temporary
    // 'retry' line judges nothing and never suppresses a relaunch.
    const handoff = v.verdict === 'needs_conductor' && v.capability === WORKER_CAPABILITY;
    if ((handoff || v.verdict === 'refused') && v.evidence === true && Array.isArray(v.file_keys)) {
      map.set(v.item_id, {
        verdict: v.verdict,
        keys: sortedKeys(v.file_keys),
        head: v.head ?? null,
        reason: typeof v.reason === 'string' ? v.reason : null,
        lane: typeof v.lane === 'string' ? v.lane : null,
        capability: v.capability ?? null,
      });
    } else if (v.verdict === 'closed') map.delete(v.item_id);
  }
  return map;
}

/** item id -> {keys, reason, lane} of its standing 'needs_conductor' verdict:
 *  the items the worker handed to the conductor. */
export function handoffVerdicts(root) {
  const out = new Map();
  for (const [id, v] of judgedVerdicts(root)) if (v.verdict === 'needs_conductor') out.set(id, { keys: v.keys, reason: v.reason, lane: v.lane });
  return out;
}

/** Is this item handed to the conductor for exactly its CURRENT file_keys? A
 *  re-mint that adds paths makes it the worker's again. */
export function isHandedOff(item, handoffs) {
  return handoffs.get(item.id)?.keys === sortedKeys(item.file_keys);
}

/** How many knowledge writes the worker landed, from the
 *  JSONL and its .1 backup (a carried count from a rotation included): the
 *  sample-audit pointer H1 shows (design (4), change CUT: a count and a path,
 *  not a rendered sample). */
export function workerWriteCount(root) {
  return { count: countWrites(journalLines(root)), path: '.sterling/maintenance-worker.jsonl' };
}

function countWrites(lines) {
  let count = 0;
  for (const v of lines) {
    if (v?.kind === 'writes_carried' && Number.isFinite(v.count)) count += v.count;
    // Every landed write counts, an unpoliced one too: the count points a
    // reader at what to spot-check.
    else if (v?.kind === 'tool_call' && v.is_error === false && KNOWLEDGE_WRITE_TOOLS.includes(v.tool)) count++;
  }
  return count;
}

/** Is this item judged for its CURRENT state? needs_conductor: same
 *  file_keys. refused (a close the server refused): same file_keys AND the
 *  same HEAD — a new commit may make the close attestable, so it becomes
 *  launchable again. */
export function isJudged(item, verdicts, head) {
  const v = verdicts.get(item.id);
  if (!v || v.keys !== sortedKeys(item.file_keys)) return false;
  return v.verdict === 'needs_conductor' || (v.verdict === 'refused' && Boolean(head) && v.head === head);
}

/** The target record's slug as the item text names it ("reconcile article
 *  '<slug>' — …", "re-verify research finding '<slug>' — …"), or null. */
export function articleSlug(item) {
  return /^(?:reconcile article|re-verify research finding) '([^']+)'/.exec(String(item?.text ?? ''))?.[1] ?? null;
}

/** Every open item in the worker's lanes, read with the same
 *  count-then-capped-query H1 uses so it can never truncate. */
export function openWorkerItems(store) {
  const total = store.count({ types: ['todo'], source: 'system' });
  if (!total) return [];
  return store.query({ types: ['todo'], source: 'system', cap: total }).filter((t) => WORKER_LANES.includes(t.system_reason));
}

/** Open worker-lane items not judged for their current state. Without a
 *  `head`, a refused verdict never counts as judged (the caller has no HEAD to
 *  compare against). */
export function unjudgedWorkerItems(store, root, head = null) {
  const verdicts = judgedVerdicts(root);
  return openWorkerItems(store).filter((t) => !isJudged(t, verdicts, head));
}

/** At most `max` items, round-robin across WORKER_LANES in their order and
 *  oldest first within a lane (design (g)), so one deep lane cannot starve the
 *  others. An item without a usable created_at sorts first in its lane, as the
 *  batching check counts it as already waited. */
export function selectBatch(items, max = RUN_BATCH_MAX) {
  const age = (t) => {
    const ms = Date.parse(t.created_at ?? '');
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  const byLane = WORKER_LANES.map((lane) => items.filter((t) => t.system_reason === lane).sort((a, b) => age(a) - age(b)));
  const out = [];
  for (let i = 0; out.length < max && byLane.some((q) => i < q.length); i++) {
    for (const q of byLane) if (i < q.length && out.length < max) out.push(q[i]);
  }
  return out;
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
 *  (.claude-plugin/sterling-mcp.json, COMMITTED with the plugin: a bare `node`
 *  and ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR} placeholders; decision
 *  sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone).
 *  Claude Code expands those placeholders only for a PLUGIN's MCP config, never
 *  for an --mcp-config handed to a headless child, so both are bound here:
 *  ${CLAUDE_PLUGIN_ROOT} to THIS plugin root (clone or installed copy), and
 *  ${CLAUDE_PROJECT_DIR} to THIS project so the child reads and writes this
 *  project's store — also in a sibling project. The bare `node` resolves on the
 *  child's PATH, which it inherits from the session that launched the hook.
 *  `policy` {path, token}, for a worker run, appends `--worker-policy <absolute
 *  path> --worker-token <token>` so the worker's own server enforces the batch
 *  policy before every mutation (change (i): argv, never ambient env). */
export function resolveMcpConfig(pluginRoot, projectRoot, policy = null) {
  if (policy && (typeof policy.token !== 'string' || !policy.token || typeof policy.path !== 'string' || !isAbsolute(policy.path))) {
    throw new Error(`the worker policy needs an absolute eligible.json path and a non-empty token (got path ${JSON.stringify(policy.path)})`);
  }
  const path = join(pluginRoot, '.claude-plugin', 'sterling-mcp.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the plugin MCP wiring ${path} (${e?.code ?? e?.message ?? e}) — it ships committed with the plugin, so this plugin tree is incomplete: restore it (git checkout -- .claude-plugin/sterling-mcp.json in a clone) or reinstall the plugin`);
  }
  const entry = parsed?.mcpServers?.[SERVER];
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    throw new Error(`${path} has no mcpServers.${SERVER} {command, args} entry`);
  }
  const bind = (s) => String(s).split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot).split('${CLAUDE_PROJECT_DIR}').join(projectRoot);
  const policyArgs = policy ? ['--worker-policy', policy.path, '--worker-token', policy.token] : [];
  return JSON.stringify({ mcpServers: { [SERVER]: { ...entry, command: bind(entry.command), args: [...entry.args.map(bind), ...policyArgs] } } });
}

export function readWorkerPrompt(pluginRoot) {
  const path = join(pluginRoot, 'templates', 'maintenance-worker-prompt.md');
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the worker prompt ${path} (${e?.code ?? e?.message ?? e})`);
  }
}

/** The shipped prompt, plus the ELIGIBLE batch the launcher chose (clean,
 *  unjudged, lane-fair) when it passed one, with each item's lane and target,
 *  plus every standing judged verdict (needs_conductor, refused) so the child
 *  skips those unless they changed. */
export function workerPrompt(pluginRoot, root, eligible = null) {
  let prompt = readWorkerPrompt(pluginRoot);
  if (eligible) {
    prompt +=
      `\nELIGIBLE (work ONLY these items; every other open item is dirty against HEAD, already judged or left for a later run, so leave it alone):\n` +
      eligible.items.map((t) => `- ${t.id} lane ${t.lane ?? 'reconcile_needed'} target ${t.feature_link ?? 'none'} file_keys ${sortedKeys(t.file_keys)}`).join('\n') +
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
  return `launch FAILED (${reason}) — the worker's items stay open; it retries after the 30-minute back-off, or drain by hand with /sterling:drain.`;
}

/**
 * Start the worker if one is owed. NEVER throws: every outcome is a result
 * object. The result carries no text for the hook to show: a back-off, a git
 * failure or a failed launch has a `detail` string that is appended to
 * maintenance-worker.log (and returned for tests), and nothing else. If that
 * log write itself fails, the result says so in `log_error`.
 *   opts.root       project root (the hook's normalized input.cwd)
 *   opts.config     .sterling/config.json (raw or parsed; null = defaults)
 *   opts.store      an open SterlingStore (or opts.items: the open queue items)
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
    // Cheap filter first (no git): only the worker's lanes, minus items handed
    // to the conductor for their current file_keys. Refused verdicts need
    // HEAD, checked below.
    const verdicts = judgedVerdicts(opts.root);
    const open = (opts.items ?? openWorkerItems(opts.store)).filter((t) => WORKER_LANES.includes(t.system_reason) && !isJudged(t, verdicts, null));
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
      return { launched: false, reason: 'git_failed', detail: `git could not report HEAD or the working-tree state in ${opts.root}, so every queue item counts as dirty and no worker starts; drain with /sterling:drain.` };
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
        detail: `${eligible.length} of ${BATCH_MIN_ITEMS} eligible items, oldest waited ${ageText(new Date(nowMs - oldestWaitMs).toISOString(), nowMs)} of ${Math.round(BATCH_MAX_WAIT_MS / 60_000)}m — no worker until ${BATCH_MIN_ITEMS} are eligible or the oldest has waited that long`,
      };
    }

    const host = opts.host ?? 'claude';
    if (!WORKER_HOSTS.includes(host)) return { launched: false, reason: 'error', detail: failDetail(`unknown runner host '${host}'`) };
    const model = opencodeModelOf(opts.config);
    if (host === 'opencode') {
      if (typeof opts.opencodeBin !== 'string' || !opts.opencodeBin) return { launched: false, reason: 'error', detail: failDetail('the opencode host needs the path of the opencode binary') };
      if (model === null) return { launched: false, reason: 'error', detail: failDetail(OPENCODE_MODEL_UNSET) };
      if (model !== null && (typeof model !== 'string' || !model.trim())) return { launched: false, reason: 'error', detail: failDetail(`config maintenance_worker.${OPENCODE_MODEL_KEY} must be a provider/model string, got ${JSON.stringify(model)}`) };
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
    // The runner host travels with the eligible list, bound to this launch by the token.
    const runnerHost = host === 'opencode' ? { host, opencode_bin: opts.opencodeBin, opencode_model: model.trim() } : { host };
    // THE BATCH POLICY (change (ii)): eligible.json is token-bound, and the
    // worker's own Sterling server reads it through --worker-policy. `items`
    // keeps its shape for the runner and the prompt; `policy_items` is the
    // server's per-item contract {id, lane, target_id, file_keys} (slice A
    // reads it there because `items` already had another shape).
    // `queue_snapshot` is every eligible item, so a run that made progress can
    // re-enter this launcher with what is left (ruling (5), chaining).
    const batch = selectBatch(eligible);
    writeFileSync(
      paths.eligible,
      JSON.stringify({
        token,
        head: git.head,
        ...runnerHost,
        items: batch.map((t) => ({ id: t.id, lane: t.system_reason, file_keys: t.file_keys ?? [], feature_link: t.feature_link ?? null, slug: articleSlug(t) })),
        policy_version: POLICY_VERSION,
        run_id: randomUUID(),
        policy_items: batch.map((t) => ({ id: t.id, lane: t.system_reason, target_id: t.feature_link ?? null, file_keys: t.file_keys ?? [] })),
        queue_snapshot: eligible.map((t) => ({ id: t.id, system_reason: t.system_reason, file_keys: t.file_keys ?? [], feature_link: t.feature_link ?? null, created_at: t.created_at ?? null, text: t.text ?? '' })),
      })
    );

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
      return { launched: true, reason: 'launched', pid: child.pid, items: batch.length, eligible: eligible.length, host };
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

/** The short tool name of a knowledge write the stamp check covers, or null. */
export function knowledgeWriteName(name) {
  const short = String(name).replace(/^mcp__(?:plugin_sterling_)?sterling__/, '');
  return KNOWLEDGE_WRITE_TOOLS.includes(short) ? short : null;
}

/** The run stamp {run_id, item_id} in a write receipt's text, or null. The
 *  receipt is JSON (the server's json() wrapper); the key is searched a few
 *  levels deep so a receipt that nests it still counts. A text that is not
 *  JSON (an OpenCode execute output that wrapped it) is searched for the key's
 *  own object. */
export function findStamp(text) {
  const valid = (s) => (s && typeof s === 'object' && typeof s.run_id === 'string' && typeof s.item_id === 'string' ? { run_id: s.run_id, item_id: s.item_id } : null);
  const search = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return null;
    if (Object.prototype.hasOwnProperty.call(v, STAMP_KEY)) return valid(v[STAMP_KEY]);
    for (const child of Object.values(v)) {
      const hit = search(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const raw = String(text ?? '');
  try {
    return search(JSON.parse(raw), 0);
  } catch {
    const m = new RegExp(`"${STAMP_KEY}"\\s*:\\s*(\\{[^{}]*\\})`).exec(raw);
    if (!m) return null;
    try {
      return valid(JSON.parse(m[1]));
    } catch {
      return null;
    }
  }
}

/** One journal entry for a knowledge write the child made. The runner adds
 *  the stamp it finds in the receipt. A line-reference fix takes no resolves,
 *  so its entry records none even if the child passed one. */
export function writeEntry(tool, input, is_error, result) {
  const shape =
    tool === 'knowledge_line_ref_fix'
      ? { field: input.field ?? null, find: input.find ?? null, replace: input.replace ?? null, anchor: input.anchor ?? null }
      : { field: input.field ?? null, resolves: Array.isArray(input.resolves) ? input.resolves.map(String) : [] };
  return { kind: 'tool_call', tool, article_id: input.id ?? null, ...shape, is_error, result };
}

/**
 * A stream-json consumer: feed() it stdout chunks; it journals every
 * maintenance_remove call and every knowledge write with its result as soon as
 * the result arrives (so a killed run still leaves its closes and writes on
 * record) and keeps the final result. Each journal call passes the result's
 * full text as a second argument, so the runner can check a write's stamp.
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
  const out = { result: null, removes: 0, closedOk: 0, lineRefFixes: 0, lineRefFixesOk: 0, writes: 0, writesOk: 0, lines: 0, mcpStatus: null, sterlingOk: 0 };
  const removeEntry = (input, is_error, result) => ({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error, result });
  const handle = (e) => {
    out.lines++;
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        const write = knowledgeWriteName(c.name);
        if (String(c.name).endsWith('__maintenance_remove')) pending.set(c.id, { write: null, input: c.input ?? {} });
        else if (write) pending.set(c.id, { write, input: c.input ?? {} });
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
        const { write, input } = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const text = Array.isArray(c.content) ? c.content.map((p) => p?.text ?? '').join('') : String(c.content ?? '');
        if (write) {
          // A refused write is the server doing its job, not an error of the run.
          journal(writeEntry(write, input, Boolean(c.is_error), text.slice(0, 400)), text);
          if (write === 'knowledge_line_ref_fix') out.lineRefFixes++;
          else out.writes++;
          if (!c.is_error) {
            if (write === 'knowledge_line_ref_fix') out.lineRefFixesOk++;
            else out.writesOk++;
            out.sterlingOk++;
          }
          continue;
        }
        journal(removeEntry(input, Boolean(c.is_error), text.slice(0, 400)), text);
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
      for (const { write, input } of pending.values()) {
        journal(write ? writeEntry(write, input, null, 'no result before the run ended') : removeEntry(input, null, 'no result before the run ended'), '');
      }
      pending.clear();
      return out;
    },
  };
}

/** Did the stream show the child SUCCESSFULLY read what this item's lane
 *  needs before a handoff verdict can stand (design (e))?
 *  - reconcile_needed, state_review: the target article AND one of its files.
 *  - stale_research: the target finding AND a re-check (a web call, or a Read
 *    or Grep in this run).
 *  - refresh_reference: the target AND one of its files, or a web call when
 *    the item names no file.
 *  - article_missing: one of its files AND a knowledge_query (the search for
 *    an existing owner).
 *  The target counts by uuid, an 8+ char uuid prefix, or its slug. A file
 *  counts by a Read of it (`seenFiles`), or by a Grep whose path is that file
 *  or a directory containing it (`seenGrepPaths`; a Grep with no path
 *  searched the project root) — conductor ruling 2026-09-29. `run` carries
 *  the run-wide reads {web, queried}: the stream does not tie a web call or a
 *  query to one item, so those two count per run, not per item. */
export function hasEvidence(item, seenArticles, seenFiles, root, seenGrepPaths = new Set(), run = {}) {
  const link = String(item.feature_link ?? '');
  const target = [...seenArticles].some((id) => (link && (id === link || (id.length >= 8 && link.startsWith(id)))) || (item.slug && id === item.slug));
  const keys = item.file_keys ?? [];
  const file = keys.some((k) => {
    const t = resolve(root, k);
    if (seenFiles.has(t)) return true;
    for (const g of seenGrepPaths) if (t === g || t.startsWith(g.endsWith(sep) ? g : g + sep)) return true;
    return false;
  });
  const web = Boolean(run.web);
  switch (item.lane ?? 'reconcile_needed') {
    case 'stale_research':
      return target && (web || seenFiles.size > 0 || seenGrepPaths.size > 0);
    case 'refresh_reference':
      return target && (file || (keys.length === 0 && web));
    case 'article_missing':
      return file && Boolean(run.queried);
    default:
      return target && file;
  }
}

/** A reason that names a temporary failure: a busy store, a version (CAS)
 *  conflict, the budget, a timeout or an unavailable source. Such an item is
 *  retried by a later run, never handed off (changes (f) and (v)). */
export const TEMPORARY_RE = /database is locked|SQLITE_BUSY|version conflict|expected_version|stale version|\bCAS\b|budget|timed out|timeout|rate.?limit|unavailable|unreachable|fetch failed|could not (?:fetch|reach|load)/i;
/** The server's refusal of a write outside the batch policy ("worker policy
 *  refused <tool>: rule '<rule>' — …"): a handoff, never temporary. */
export const POLICY_REFUSAL_RE = /worker policy refused/i;

/** The settings the runner relaunches with, from .sterling/config.json: null
 *  for no file (defaults), or a {problem} when it cannot be read. */
function readProjectConfig(root) {
  const c = readJson(join(root, '.sterling', 'config.json'));
  if (c?.unreadable) return { problem: `config.json unreadable (${c.unreadable})` };
  return { config: c };
}

/**
 * The runner's body: run the child on the launcher's ELIGIBLE batch, journal
 * every maintenance_remove call, knowledge write and verdict (a refused close
 * becomes a 'refused' verdict keyed by id, file_keys and HEAD), record the
 * outcome, release the lock, then start the next run when this one made
 * progress and eligible work is left. Returns the process exit code. opts:
 * {root, pluginRoot, spawn, now, dryRun, out, log, trigger, token, budgetUsd,
 * claudeBin, timeoutMs, logCapBytes, host, opencodeBin, opencodeModel,
 * relaunch, spawnSync}; host and the opencode fields default to what the
 * launcher recorded in eligible.json, and host to 'claude'. `relaunch(items)`
 * replaces the chained launcher call, and `spawnSync` is the chained launch's
 * git probe (both tests only).
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
  // The host comes from the launcher (eligible.json) unless the caller names one.
  const hostOf = (eligible) => opts.host ?? eligible?.host ?? 'claude';
  /** {bin, args, env} for the chosen host. Both hosts share WORKER_TIMEOUT_MS
   *  (change (vii)); the OpenCode runner has no per-run budget flag, so only
   *  the timeout bounds it. */
  const buildRun = (eligible) => {
    const prompt = workerPrompt(opts.pluginRoot, opts.root, eligible);
    const mcpConfig = resolveMcpConfig(opts.pluginRoot, opts.root, eligible ? { path: resolve(paths.eligible), token: eligible.token } : null);
    const host = hostOf(eligible);
    if (host === 'opencode') {
      const ocBin = opts.opencodeBin ?? eligible?.opencode_bin;
      if (!ocBin) throw new Error('the opencode host was chosen but no opencode binary was recorded for this launch');
      const model = opts.opencodeModel ?? eligible?.opencode_model ?? null;
      if (typeof model !== 'string' || !model.trim()) throw new Error(OPENCODE_MODEL_UNSET);
      const config = buildOpencodeConfig({ mcpConfig, model });
      return { host, bin: ocBin, args: buildOpencodeArgs({ prompt: opencodePrompt(prompt), model }), env: opencodeEnv({ root: opts.root, config }) };
    }
    if (host !== 'claude') throw new Error(`unknown runner host '${host}'`);
    return { host, bin, args: buildWorkerArgs({ prompt, mcpConfig, budgetUsd: budgetOk ? budgetUsd : rawBudget }), env: {} };
  };
  if (opts.dryRun) {
    let run;
    try {
      run = buildRun(opts.token ? readEligible() : null);
    } catch (e) {
      // An unknown host, a missing binary or model, or a broken plugin tree: the
      // dry run prints what the real run would refuse with, and fails.
      (opts.out ?? console.log)(JSON.stringify({ dry_run: true, cwd: opts.root, refused: e?.message ?? String(e) }, null, 2));
      return 1;
    }
    (opts.out ?? console.log)(JSON.stringify({ dry_run: true, cwd: opts.root, host: run.host, command: run.bin, argv: run.args, ...(run.host === 'opencode' ? { env: run.env } : {}) }, null, 2));
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
  // Set when this run should start the next one, after the lock is released.
  let chain = null;
  let exitCode = 1;
  try {
    exitCode = await (async () => {
      // A malformed or zero budget is a recorded failure (state written, back-off
      // armed), never a silent exit.
      if (!budgetOk) {
        record({ ok: false, at: iso(), error: `invalid --budget-usd '${rawBudget}' (needs a number >= ${MIN_RUN_BUDGET_USD})` });
        return 1;
      }
      // A run without the launcher's token has no batch policy, so its server
      // would not police the write grant: refuse it (fail closed, change (i)).
      if (!opts.token) {
        record({ ok: false, at: iso(), error: 'no launch token: a worker run needs the batch policy the launcher writes (use --dry-run to print the argv)' });
        return 1;
      }
      const eligible = readEligible();
      if (!eligible) {
        record({ ok: false, at: iso(), error: 'the eligible-item list is missing or belongs to another launch' });
        return 1;
      }
      let run;
      try {
        run = buildRun(eligible);
      } catch (e) {
        record({ ok: false, at: iso(), error: e?.message ?? String(e) });
        return 1;
      }
      // A refused close on an eligible item is recorded as a 'refused' verdict
      // keyed by id, file_keys and HEAD, so the launcher skips it until one of
      // them changes (an item the server always refuses must not relaunch the
      // worker at every Stop). A permission denial is not a server refusal.
      const byId = new Map(eligible.items.map((t) => [t.id, t]));
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
      // FAIL CLOSED (change (i)): every successful knowledge write must carry
      // this run's stamp naming an item of this batch. The server checks
      // before the write; this is the after-the-fact observation of it.
      let writesStamped = 0;
      const unpoliced = [];
      const closedIds = new Set();
      const resolvedIds = new Set();
      const journalCall = (entry, raw = '') => {
        if (entry.kind === 'tool_call' && KNOWLEDGE_WRITE_TOOLS.includes(entry.tool) && entry.is_error === false) {
          const stamp = findStamp(raw);
          entry = { ...entry, stamp };
          if (!stamp || stamp.run_id !== eligible.run_id || !byId.has(stamp.item_id)) {
            unpoliced.push(`${entry.tool} on ${entry.article_id ?? 'unknown record'}`);
            journal({ ...entry, unpoliced: true });
            return;
          }
          journal(entry);
          if (entry.tool === 'knowledge_line_ref_fix') return; // never progress on its own
          writesStamped++;
          for (const id of entry.resolves ?? []) if (byId.has(id)) resolvedIds.add(id);
          return;
        }
        journal(entry);
        if (entry.tool !== 'maintenance_remove') return;
        if (entry.is_error === false && byId.has(entry.item_id)) closedIds.add(entry.item_id);
        if (entry.kind === 'tool_call' && entry.is_error === true && BUSY_RE.test(entry.result ?? '')) {
          // A locked store is retry-later, not the server's judgment: no 'refused'
          // verdict, no evidence stamp, so judgedVerdicts ignores it and the item
          // stays eligible for a later run.
          busyCalls++;
          if (byId.has(entry.item_id)) journal({ kind: 'verdict', item_id: entry.item_id, verdict: 'busy', reason: String(entry.result ?? '').slice(0, 200) });
        } else if (entry.kind === 'tool_call' && entry.is_error === true && byId.has(entry.item_id) && !/permission/i.test(entry.result ?? '')) {
          // The server's refusal IS the evidence for this verdict.
          journal({ kind: 'verdict', item_id: entry.item_id, lane: byId.get(entry.item_id).lane ?? null, verdict: 'refused', file_keys: byId.get(entry.item_id).file_keys, head: eligible.head, evidence: true, reason: String(entry.result ?? '').slice(0, 200) });
          refusedVerdicts++;
          if (!repeatRefusal(entry.item_id)) newRefusals++;
        }
      };
      // EVIDENCE GATE (P3, not the prompt alone): what the child actually read.
      // Fed only by calls whose result came back without an error.
      const seenArticles = new Set();
      const seenFiles = new Set();
      const seenGrepPaths = new Set();
      const runReads = { web: false, queried: false };
      const observe = (name, input) => {
        if (name.endsWith('__knowledge_get') && input.id) seenArticles.add(String(input.id));
        else if (name.endsWith('__knowledge_query')) runReads.queried = true;
        else if (name === 'Read' && input.file_path) seenFiles.add(abs(input.file_path));
        else if (name === 'Grep') seenGrepPaths.add(input.path ? abs(input.path) : resolve(opts.root));
        else if (name === 'WebSearch' || name === 'WebFetch') runReads.web = true;
      };
      // Both hosts' parsers feed the SAME journalCall and observe, so one gate judges both.
      const launchKeys = new Map([...byId].map(([id, t]) => [id, t.file_keys ?? []]));
      const stream = run.host === 'opencode' ? opencodeStreamJournal(journalCall, observe, launchKeys) : streamJournal(journalCall, observe, launchKeys);
      const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
      const logCap = opts.logCapBytes ?? LOG_RUN_CAP_BYTES;
      let logged = 0;
      const { code, spawnError, timedOut } = await new Promise((resolve) => {
        let child;
        try {
          child = opts.spawn(run.bin, run.args, { cwd: opts.root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, [WORKER_ENV_FLAG]: '1', CLAUDE_PROJECT_DIR: opts.root, ...run.env } });
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
      const { result, removes, closedOk, lineRefFixes, lineRefFixesOk, writes, mcpStatus, sterlingOk } = stream.end();
      if (spawnError) {
        record({ ok: false, at: iso(), error: `could not start ${run.bin}: ${spawnError.message ?? spawnError}` });
        return 1;
      }
      const verdicts = parseVerdicts(result?.result);
      const marker = { capability: WORKER_CAPABILITY };
      let evidenced = 0;
      let retries = 0;
      for (const v of verdicts) {
        const item = byId.get(v.item_id);
        const lane = item?.lane ?? v.lane ?? null;
        // Only the allowed fields are copied from the child: evidence, head and
        // file_keys are the runner's to set. A 'refused' verdict comes only
        // from the runner's own stream observation, never from the child.
        if (v.verdict === 'refused') {
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, lane, verdict: 'unjudged', reason: 'a refused verdict is recorded by the runner, not the child', claimed_reason: v.reason ?? null, ...marker });
          continue;
        }
        // A legacy 'owes_prose' from the child is the old name of a handoff.
        if (v.verdict !== 'needs_conductor' && v.verdict !== 'owes_prose') {
          if (v.verdict === 'retry') retries++;
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, lane, verdict: v.verdict, reason: v.reason ?? null, ...marker });
          continue;
        }
        const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
        if (!reason) {
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, lane, verdict: 'unjudged', reason: 'a handoff without a reason', ...marker });
          continue;
        }
        // A temporary failure is never a standing handoff: the item stays the
        // worker's and a later run retries it.
        // A worker-policy refusal is a standing handoff whatever its detail
        // names: the write is outside the policy, so retrying cannot help.
        if (!POLICY_REFUSAL_RE.test(reason) && TEMPORARY_RE.test(reason)) {
          retries++;
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, lane, verdict: 'retry', reason: reason.slice(0, 300), claimed: 'needs_conductor', ...marker });
          continue;
        }
        // A handoff stands only when the stream shows the reads its lane
        // needs. Otherwise it is 'unjudged' and suppresses nothing.
        if (item && hasEvidence(item, seenArticles, seenFiles, opts.root, seenGrepPaths, runReads)) {
          journal({ kind: 'verdict', item_id: v.item_id, article: v.article ?? null, lane, verdict: 'needs_conductor', reason: reason.slice(0, 300), file_keys: item.file_keys, evidence: true, ...marker });
          evidenced++;
        } else {
          journal({ kind: 'verdict', item_id: v.item_id ?? null, article: v.article ?? null, lane, verdict: 'unjudged', reason: 'no evidence', claimed_reason: reason.slice(0, 300), ...marker });
        }
      }
      // A resolves claim on a successful stamped write closed its item.
      for (const id of resolvedIds) closedIds.add(id);
      // PROGRESS (change (vi)): a close (maintenance_remove or resolves) or a
      // landed factual edit. A line-reference fix is never progress on its own
      // (the server accepts a shift back and forth).
      const progressed = closedIds.size > 0 || writesStamped > 0;
      const subtype = String(result?.subtype ?? '');
      const budgetCapped = /max_budget/i.test(subtype);
      // A budget cap reached after progress is a normal bounded end.
      const budgetEnd = budgetCapped && progressed;
      const denials = Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0;
      const problems = [
        timedOut ? `killed after ${Math.round(timeoutMs / 60_000)} min timeout` : null,
        code !== 0 && !budgetEnd ? `exit ${code}` : null,
        result ? null : run.host === 'opencode' ? 'no final text or error event from opencode run' : 'no stream-json result event',
        (result?.is_error || subtype.startsWith('error')) && !budgetEnd ? `error result (${result?.subtype ?? 'unknown'})` : null,
        denials ? `${denials} permission denial(s)` : null,
        mcpBroken(mcpStatus, sterlingOk) ? `MCP server '${SERVER}' not connected (${mcpStatus}${mcpStatus === 'failed' || mcpStatus === 'disconnected' ? '' : '; no successful sterling tool call'})` : null,
        unpoliced.length ? `unpoliced write: ${unpoliced.length} successful knowledge write(s) without this run's ${STAMP_KEY} (${unpoliced.slice(0, 3).join('; ')})` : null,
      ].filter(Boolean);
      const cost = Number(result?.total_cost_usd);
      // No reported cost (killed, crashed, hung: no result event) records null,
      // never a made-up $0.
      const reported = result && Number.isFinite(cost);
      const ok = problems.length === 0;
      record({
        ok,
        at: iso(),
        error: problems.length ? problems.join('; ') : null,
        verdicts: verdicts.length,
        closed: verdicts.filter((v) => v.verdict === 'closed').length,
        remove_calls: removes,
        closes_ok: closedOk,
        resolves_closed: resolvedIds.size,
        writes: writes,
        writes_ok: writesStamped,
        unpoliced_writes: unpoliced.length,
        evidenced_verdicts: evidenced,
        retry_verdicts: retries,
        // No evidence-backed handoff, no close, no landed edit and no NEW
        // refusal: back off like a failure. A locked-database remove is none of
        // these: a run that only hit the lock backs off, which is the retry delay.
        refused_verdicts: refusedVerdicts,
        busy_calls: busyCalls,
        line_ref_fixes: lineRefFixes,
        line_ref_fixes_ok: lineRefFixesOk,
        no_progress: evidenced === 0 && !progressed && newRefusals === 0,
        budget_capped: budgetCapped,
        cost_usd: reported ? cost : null,
        // The MCP server's status from the stream's init event (null: never
        // reported); mcpBroken says when it counts as breakage.
        mcp_status: mcpStatus,
        host: run.host,
      });
      // CHAINING (ruling (5)): a run that closed or fixed an item starts the
      // next one when eligible work is left. The launcher re-checks every item
      // (judged, dirty, batching) and applies lock, debounce and back-off.
      if (ok && progressed) {
        const snapshot = Array.isArray(eligible.queue_snapshot) ? eligible.queue_snapshot : [];
        const left = snapshot.filter((t) => t && !closedIds.has(t.id));
        if (left.length) chain = { items: left, host: eligible.host, opencodeBin: eligible.opencode_bin };
      }
      return ok ? 0 : 1;
    })();
  } finally {
    // Release only OUR lock: a stale-lock takeover may have replaced it.
    releaseLock(paths, token);
  }
  if (chain) {
    const relaunched = relaunchAfterRun(opts, chain);
    journal({ kind: 'chain', launched: relaunched.launched, reason: relaunched.reason, items_left: chain.items.length, ...(relaunched.detail ? { detail: relaunched.detail } : {}) });
  }
  return exitCode;
}

/** Re-enter the launcher after a run that made progress. The runner's own
 *  environment carries WORKER_ENV_FLAG (it guards the child's hooks), so it is
 *  dropped here or the launcher would refuse as 'inside_worker'. Never throws. */
function relaunchAfterRun(opts, chain) {
  try {
    if (opts.relaunch) return opts.relaunch(chain.items) ?? { launched: false, reason: 'unknown' };
    const cfg = readProjectConfig(opts.root);
    if (cfg.problem) return { launched: false, reason: 'error', detail: `not chained: ${cfg.problem}` };
    const { [WORKER_ENV_FLAG]: _inside, ...env } = process.env;
    return maybeLaunchMaintenanceWorker({
      root: opts.root,
      config: cfg.config,
      items: chain.items,
      trigger: 'chain',
      spawn: opts.spawn,
      pluginRoot: opts.pluginRoot,
      env,
      // Test seams the runner already carries; unset in a real run.
      ...(opts.now ? { now: opts.now() } : {}),
      ...(opts.spawnSync ? { spawnSync: opts.spawnSync } : {}),
      ...(chain.host === 'opencode' ? { host: 'opencode', opencodeBin: chain.opencodeBin } : {}),
    });
  } catch (e) {
    return { launched: false, reason: 'error', detail: `not chained: ${e?.message ?? e}` };
  }
}
