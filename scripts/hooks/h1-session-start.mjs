// H1 — conventions + banner (spec §6 H1). SessionStart, non-blocking.
// Conventions go to Claude as additionalContext; board/maintenance counts go
// to the human as systemMessage — the queue is event-drained and otherwise
// invisible; this is its visibility pressure. Banner art goes to stderr
// (adjudicated 2026-06-12): a SessionStart hook sees no CLI flags or pipe
// state, so suppression is env-only (STERLING_NO_BANNER=1).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, allow, openStore } from './lib/common.mjs';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '@sterling/schemas';

const CONVENTIONS = [
  'Sterling conventions (injected by H1):',
  '- Anti-speculation: never invent an API, field, flag, or behavior; cite tool-call evidence from this turn or say "I don\'t know, checking" and check.',
  '- No false action claims: never imply something was saved, run, or recorded unless it was actually performed this turn.',
  '- Canonical naming: one name per concept, from the registries; phase execution, intake, steps — kill synonyms on sight.',
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
 *  walk-up that works from scripts/hooks/ (source, tests) and hooks/ (bundle). */
function pluginRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
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

let counts = { todos: 0, maintenance: 0 };
try {
  const todos = store.query({ types: ['todo'], cap: 1000 });
  counts.todos = todos.filter((t) => t.source === 'user').length;
  counts.maintenance = todos.filter((t) => t.source === 'system').length;
} finally {
  store.close();
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

/** Is the process that wrote the marker still alive? signal 0 probes existence
 *  without delivering a signal: success or EPERM (exists, not ours to signal) =
 *  alive; ESRCH = no such process = confirmed dead; any other error = null
 *  (indeterminate — caller must not suppress a real warning on it). */
function markerPidAlive(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return null;
  }
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
  // Is the process that wrote the marker still alive? A confirmed-dead writer is
  // an ORPHANED marker from a server we have since replaced (the restart-after-
  // rebuild race — no platform ordering guarantee between this hook and the new
  // server's boot write). Dead → suppress; indeterminate (null) → still warn.
  const verdict = stalenessVerdict(currentBuildId, marker, marker ? markerPidAlive(marker.pid) : null);
  if (verdict.state === 'stale') {
    staleWarning = `⚠ Sterling MCP server is STALE — running build ${verdict.running}, current ${verdict.current}. RESTART THE SESSION to load the current server (a stale server silently mis-stores domain writes). `;
  }
} catch {
  // fail-open — the staleness guard must never break SessionStart
}

if (process.env.STERLING_NO_BANNER !== '1') {
  const width = Math.max(...BANNER_ROWS.map((r) => r.length));
  const version = pluginVersion();
  const versionLine = version ? `v${version}`.padStart(width) + '\n' : '';
  process.stderr.write(`${paint(BANNER_ROWS)}\n${versionLine}`);
}

const output = {
  systemMessage: `${staleWarning}${counts.todos} todo${counts.todos === 1 ? '' : 's'} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending`,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONVENTIONS + registryContext },
};
process.stdout.write(JSON.stringify(output));
allow();
