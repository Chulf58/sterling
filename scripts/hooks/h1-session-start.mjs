// H1 — conventions + banner (spec §6 H1). SessionStart, non-blocking.
// Conventions go to Claude as additionalContext; board/maintenance counts go
// to the human as systemMessage — the queue is event-drained and otherwise
// invisible; this is its visibility pressure. Banner art goes to stderr
// (adjudicated 2026-06-12): a SessionStart hook sees no CLI flags or pipe
// state, so suppression is env-only (STERLING_NO_BANNER=1).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, allow, openStore, loadConfig } from './lib/common.mjs';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '@sterling/schemas';
import { parseInstalledHeader, extractBakedCommandPaths } from '../lib/agent-distribution.mjs';

const CONVENTIONS = [
  'Sterling conventions (injected by H1):',
  '- Anti-speculation: never invent an API, field, flag, or behavior; cite tool-call evidence from this turn or say "I don\'t know, checking" and check.',
  '- No false action claims: never imply something was saved, run, or recorded unless it was actually performed this turn.',
  '- Canonical naming: one name per concept, from the registries; phase execution, intake, steps — kill synonyms on sight.',
  // Injected here, not in CLAUDE.md: H1 ships from the shared plugin clone, so these
  // reach every project at its next session start with no per-project copy and no
  // stamp-contract propagation — the same reason the todo/note routing lines live on
  // the commands. Stated because the user was otherwise re-declaring them per project.
  // Delegation: the anti-quota half leads DELIBERATELY. An earlier revision of this
  // rule read "3-5 active at all times" in a consuming project and the user withdrew it
  // within a day — "i am afraid that a session will feel force to spend up subagents even
  // if they see necessary" — and the same concern was raised again here on 2026-07-29:
  // "i am afraid that the conductor feel force to dispatch subagents without any value,
  // for the sake of just doing it to keep the claude.md happy". Leading with "up to 5"
  // reads as a target; leading with the ceiling reads as a limit. Both halves of the
  // watchdog conditional bind, and over-dispatch is named a DEFECT rather than waste,
  // because a rule that only pushes one way is the rule that produced the fear.
  '- Delegation: FIVE concurrent subagents is a CEILING, not a target — there is no floor, no quota and no expectation. This convention is NEVER satisfied by dispatching: an idle slot is not a finding, and a session that delegated nothing and did the work itself has violated nothing. Dispatch where it buys something real — speed on genuinely independent work, an independent pair of eyes on quality, or protecting the conductor context window. Dispatching without value is a DEFECT, not a neutral choice: it loses twice, burning tokens AND returning a report the conductor must read and verify, spending the very context the delegation was meant to protect.',
  '- The count is a trigger to CHECK, never a level to maintain: "fewer than 3 agents running AND work available? dispatch". Both halves bind — being below three prompts one question, is there parallel work, and "no" is a complete and correct answer that ends the matter. Dispatch several independent things in ONE message so they actually overlap; when there is one thing to do, do the one thing. The real failure is never "too few agents" — it is the conductor reading files by hand that an agent should have read for it.',
  '- The Workflow tool stays OPT-IN and needs the user\'s explicit per-prompt ask ("use a workflow" / "ultracode") or the session setting — its fan-out is an order of magnitude larger, so that cost stays theirs to authorize. Dispatches the brain returns during an active run, and the conductor_direct agents (librarian/debugger) on a task already stated, are authorized work either way.',
  // Explorer is SONNET (user, 2026-07-29). The convention states the PIN, not the reasoning:
  // the rationale lives in the store (decision + the paired-exploration research_finding), and
  // conventions injected on every session stay short to stay read.
  '- Every spawned agent carries an EXPLICIT pinned model: opus for judgment, sonnet for authoring, exploration and mechanical work. NEVER haiku for a spawned agent, and NEVER Fable without the user\'s prior agreement for that specific spawn — and never a silent inherit of the session model.',
  '- A SUBAGENT RESULT IS EVIDENCE, NOT A VERDICT. Treat every exhaustiveness claim in an agent report ("all N files", "every hook", "ruled out none") as unverified until you have the count yourself — measured 2026-07-29, explorers at two different tiers BOTH asserted "all N" from a partial sweep. One grep -c is cheaper than a conclusion built on one.',
].join('\n');

// swappable art slot (§6 H1): fixed-width ≤40 cols, fits the 35% split pane
const BANNER_ROWS = [
  '▄▀▀ ▀█▀ █▀▀ █▀▄ █   ▀█▀ █▄ █ ▄▀▀▄',
  '▀▀▄  █  █▀▀ █▀▄ █    █  █ ▀█ █ ▄▄',
  '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀',
];

// sterling-silver gradient, lerped per column: white → silver → steel blue
const GRADIENT = [
  [255, 255, 255],
  [192, 192, 200],
  [70, 100, 130],
];

function colorAt(t) {
  const [from, to, u] = t <= 0.5 ? [GRADIENT[0], GRADIENT[1], t * 2] : [GRADIENT[1], GRADIENT[2], (t - 0.5) * 2];
  return from.map((v, i) => Math.round(v + (to[i] - v) * u));
}

function paint(rows) {
  if (process.env.NO_COLOR) return rows.join('\n');
  const width = Math.max(...rows.map((r) => r.length));
  return rows
    .map(
      (row) =>
        [...row]
          .map((ch, x) => {
            if (ch === ' ') return ch;
            const [r, g, b] = colorAt(width <= 1 ? 0 : x / (width - 1));
            return `\x1b[38;2;${r};${g};${b}m${ch}`;
          })
          .join('') + '\x1b[0m'
    )
    .join('\n');
}

/** The plugin root — the dir holding .claude-plugin/plugin.json — by a bounded
 *  walk-up that works from scripts/hooks/ (source, tests) and hooks/ (bundle).
 *  STERLING_PLUGIN_ROOT overrides for tests (mirrors STERLING_SERVER_DIST
 *  below): the real walk always resolves to the one clone the test process
 *  runs from, so a test cannot otherwise put cwd AT the plugin root without
 *  faking fixtures inside that live clone's own .sterling/. */
function pluginRoot() {
  if (process.env.STERLING_PLUGIN_ROOT) return process.env.STERLING_PLUGIN_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** POSIX-ish path equality for the self-hosted-clone check below: strips a
 *  trailing slash and normalizes backslashes, but does NOT resolve symlinks —
 *  both sides already come from path.resolve/dirname/join in this process. */
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** Plugin version, fail-open (no version, no line). */
function pluginVersion() {
  try {
    const root = pluginRoot();
    if (!root) return null;
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v.length ? v : null;
  } catch {
    // fail-open — the banner prints without a version line
  }
  return null;
}

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

// H1 is SOFT (banner + conventions + counts): a malformed config must cost the
// deep-queue threshold, never the conventions injection, so this read is guarded
// and falls back to the schema default rather than throwing. Contrast the gates
// (H3/H5/H14/H15), which fail CLOSED on exactly this input — a hook that cannot
// evaluate must deny only where denying is its job (anti_pattern e13f0fb5).
let config = null;
try {
  config = loadConfig(input.cwd);
} catch {
  config = null;
}

// MACHINE ROLE (todo cabbc10f, decision a9b98b7d): stated ONLY when this
// session's project IS a Sterling clone itself — comparing the normalized
// input.cwd to pluginRoot(). Every OTHER Sterling project (a consumer of the
// plugin, not a clone of it) never sees this line; it exists because the
// committed CLAUDE.md's "this machine authors" prose travels with every
// clone and misleads a session opened inside one. Guarded exactly like the
// config read above — H1 is soft, so a malformed config costs this line, never
// the conventions injection.
let roleContext = '';
try {
  const root = pluginRoot();
  if (root && samePath(input.cwd, root)) {
    const role = config?.machine_role;
    if (role === 'authoring') {
      roleContext =
        '\n\nMACHINE ROLE: AUTHORING (declared in .sterling/config.json machine_role) — Sterling work lands and merges here; CLAUDE.md\'s authoring contract applies.';
    } else if (role === 'consumer') {
      roleContext =
        '\n\nMACHINE ROLE: CONSUMER — this clone consumes via /sterling:update. The committed CLAUDE.md\'s "this machine authors" language does NOT apply on this machine: never commit here, never hand-reconcile drift; a dirty generated file is discarded (git checkout -- <path>); currency comes only from /sterling:update.';
    } else {
      roleContext =
        '\n\nMACHINE ROLE: UNDECLARED — treat as CONSUMER (the safe posture) until declared. The authoring machine declares machine_role:"authoring" in .sterling/config.json once; a successful /sterling:update stamps "consumer" automatically.';
    }
  }
} catch {
  // fail-open — a malformed config or unresolved plugin root costs only this line
}

let counts = { todos: 0, maintenance: 0 };
let queueReasons = [];
try {
  const todos = store.query({ types: ['todo'], cap: 1000 });
  counts.todos = todos.filter((t) => t.source === 'user').length;
  const system = todos.filter((t) => t.source === 'system');
  counts.maintenance = system.length;
  // Lane breakdown for the deep-queue signal below: a bare total says "drain",
  // a per-lane split says WHAT is owed, which is what decides how to drain it.
  const byReason = new Map();
  for (const t of system) byReason.set(t.system_reason, (byReason.get(t.system_reason) ?? 0) + 1);
  queueReasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ×${n}`);
} finally {
  store.close();
}

// DEEP-QUEUE SIGNAL TO THE CONDUCTOR (config.maintenance_queue.deep_threshold).
// The counts above go to the human as a systemMessage, which the MODEL never
// sees — correct while the queue is shallow and event-drained, wrong once it is
// deep, because the human is not the one who drains it. A consuming project
// reached 63 items, most of them work finished days earlier and never closed,
// with nothing anywhere prompting a drain (reported 2026-07-29). Silent below the
// threshold (P1); above it, states the depth, the lanes, and the remedy.
let queueContext = '';
if (counts.maintenance >= (config?.maintenance_queue?.deep_threshold ?? 15)) {
  queueContext =
    `\n\nMAINTENANCE QUEUE IS DEEP — ${counts.maintenance} open items (${queueReasons.join(', ')}).\n` +
    `Drain it with /sterling:drain before taking new work, and expect much of it to be ALREADY DONE: ` +
    `the queue records debt the mechanism detected, not debt that is necessarily still owed, so each item is verified against HEAD first ` +
    `(an already-paid item closes with board_remove and NO knowledge_update — a version bump claiming a reconcile that added nothing is itself drift). ` +
    `A deep queue is also a signal in its own right: items that keep arriving faster than they close mean either the drain is being skipped or a hook is over-firing.`;
}

// shared project registry (decision 8f9e6db2): touch THIS project's last_seen
// for the session, and make the CONDUCTOR aware of sibling projects via
// additionalContext (NOT systemMessage — this is conductor awareness, not a
// human banner). Only if the registry exists (init creates it) — H1 never
// creates it, and touchLastSeen no-ops for a project that was never registered.
// Missing (stale) siblings are excluded — irrelevant to the conductor; the
// /sterling:projects peek surfaces them for human pruning.
let registryContext = '';
if (existsSync(registryPath())) {
  const cwdPosix = input.cwd.replace(/\\/g, '/');
  const registry = new ProjectRegistry(registryPath());
  try {
    registry.touchLastSeen(cwdPosix, new Date().toISOString());
    const siblings = registry.list().filter((p) => p.repo_path !== cwdPosix && existsSync(p.repo_path));
    if (siblings.length) {
      registryContext =
        '\n\nSibling Sterling projects on this machine (shared project registry) — other initialized projects; ' +
        'knowledge in any domain you both declare (stack_tags) is shared through the per-user domain stores:\n' +
        siblings.map((p) => `- ${p.name}: ${p.stack_tags.join(', ') || '(no domains)'}`).join('\n');
    }
  } finally {
    registry.close();
  }
}

/** Is the process that wrote the marker still alive — and actually the WRITER?
 *  signal 0 probes existence without delivering a signal: success or EPERM
 *  (exists, not ours to signal) = a live process; ESRCH = confirmed dead; any
 *  other error = null (indeterminate — caller must not suppress a real warning
 *  on it). Existence alone over-warns: pid numbering resets on reboot (WSL
 *  restarts routinely), so an orphan marker's pid is often REUSED by an
 *  unrelated process and the dead-writer suppression (decision 132177d2) fails
 *  — observed 2026-07-02. On Linux, confirm identity via /proc/<pid>/cmdline:
 *  the writer is always the MCP server, launched from .../packages/mcp-server/
 *  dist, so a live cmdline WITHOUT 'mcp-server' is a reused pid = confirmed
 *  not-the-writer = dead. An empty/unreadable cmdline or a non-Linux platform
 *  keeps the existence verdict (err loud: a missed real warning is worse than
 *  a rare false one). */
function markerWriterAlive(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code !== 'EPERM') return null;
  }
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    if (cmdline && !cmdline.includes('mcp-server')) return false; // reused pid — not the writer
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return false; // exited between probe and read
    // other read errors: identity indeterminate — keep the existence verdict
  }
  return true;
}

// stale-server guard (P5/P7): a running MCP server older than the current built
// server silently serves OLD behavior (the domain-stores incident). Compare the
// build-id the server recorded at boot to the current built id; warn the human
// loudly to restart. Fail-open: a missing marker or build-id is 'unknown', never
// a false alarm (P1). STERLING_SERVER_DIST overrides the dist lookup for tests.
let staleWarning = '';
try {
  const root = pluginRoot();
  const serverDist = process.env.STERLING_SERVER_DIST ?? (root ? join(root, 'packages', 'mcp-server', 'dist') : null);
  const currentBuildId = serverDist && existsSync(buildIdPath(serverDist)) ? readFileSync(buildIdPath(serverDist), 'utf8').trim() || null : null;
  let marker = null;
  const markerPath = runtimeMarkerPath(join(input.cwd, '.sterling', 'sterling.db'));
  if (existsSync(markerPath)) {
    const parsed = runtimeMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, 'utf8')));
    if (parsed.success) marker = parsed.data;
  }
  // Is the process that wrote the marker still alive AND the writer? A confirmed-
  // dead (or confirmed-reused-pid) writer is an ORPHANED marker from a server we
  // have since replaced (the restart-after-rebuild race — no platform ordering
  // guarantee between this hook and the new server's boot write). Dead → suppress;
  // indeterminate (null) → still warn.
  const verdict = stalenessVerdict(currentBuildId, marker, marker ? markerWriterAlive(marker.pid) : null);
  if (verdict.state === 'stale') {
    staleWarning = `⚠ Sterling MCP server is STALE — running build ${verdict.running}, current ${verdict.current}. RESTART THE SESSION to load the current server (a stale server silently mis-stores domain writes). `;
  }
} catch {
  // fail-open — the staleness guard must never break SessionStart
}

// Machine-activation guard (todo 8789eccf, anti_pattern 60e8463d): installed
// agents bake node paths per machine context (d53dc92c); a WSL↔Windows context
// flip leaves every agent hook failing non-blocking — the enforcement floor is
// silently absent while sync-agents' hash bookkeeping reads up_to_date. Probe
// the baked node paths of Sterling-generated installs at session start and
// warn BOTH surfaces: the human (systemMessage) and the conductor
// (additionalContext, with the recovery duty). Fail-open — the probe must
// never break SessionStart.
let machineWarning = '';
let machineContext = '';
try {
  const agentsDir = join(input.cwd, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    const dead = [];
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
      const content = readFileSync(join(agentsDir, f), 'utf8');
      if (!parseInstalledHeader(content)) continue; // foreign/hand-made — not ours to judge
      const unresolved = extractBakedCommandPaths(content).find((p) => !existsSync(p));
      if (unresolved) dead.push({ agent: f, node: unresolved });
    }
    if (dead.length) {
      machineWarning =
        `⚠ ${dead.length} installed agent(s) carry hook commands baked for ANOTHER machine context ` +
        `(e.g. ${dead[0].agent} → ${dead[0].node}) — their hooks fail silently. ` +
        `Run /sterling:sync-agents from this context, then restart. `;
      machineContext =
        `\n\nMACHINE-CONTEXT DRIFT (H1, anti_pattern 60e8463d): ${dead.length} installed agent(s) in ` +
        `.claude/agents/ carry hook node paths that do not resolve on this machine ` +
        `(${dead.map((d) => d.agent).join(', ')}). Every hook of those agents fails non-blocking — ` +
        `the enforcement floor (H3/H4/H5/H6/H14/H17) is ABSENT for them. Before dispatching any ` +
        `subagent: run scripts/sync-agents.mjs --target <project> from this context (re-bakes as ` +
        `machine_rebaked), tell the user a RESTART is required, and do not start pipeline work ` +
        `until scripts/check-agents-visible.mjs passes.`;
    }
  }
} catch {
  // fail-open — never break SessionStart (P1); the check-agents-visible gate
  // still blocks pipeline dispatch on the same condition.
}

if (process.env.STERLING_NO_BANNER !== '1') {
  const width = Math.max(...BANNER_ROWS.map((r) => r.length));
  const version = pluginVersion();
  const versionLine = version ? `v${version}`.padStart(width) + '\n' : '';
  process.stderr.write(`${paint(BANNER_ROWS)}\n${versionLine}`);
}

const output = {
  systemMessage: `${staleWarning}${machineWarning}${counts.todos} todo${counts.todos === 1 ? '' : 's'} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending`,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONVENTIONS + roleContext + registryContext + machineContext + queueContext },
};
process.stdout.write(JSON.stringify(output));
allow();
