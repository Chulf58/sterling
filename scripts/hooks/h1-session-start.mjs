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

/** Plugin version, fail-open (no version, no line): the bounded walk-up finds
 *  .claude-plugin/plugin.json from scripts/hooks/ (source, tests) and hooks/
 *  (bundle) alike. */
function pluginVersion() {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      const p = join(dir, '.claude-plugin', 'plugin.json');
      if (existsSync(p)) {
        const v = JSON.parse(readFileSync(p, 'utf8')).version;
        return typeof v === 'string' && v.length ? v : null;
      }
      dir = dirname(dir);
    }
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
// for the session and surface sibling projects (machine-global awareness). Only
// if the registry exists (init creates it) — H1 never creates it, and
// touchLastSeen no-ops for a project that was never registered.
let registryLine = '';
if (existsSync(registryPath())) {
  const cwdPosix = input.cwd.replace(/\\/g, '/');
  const registry = new ProjectRegistry(registryPath());
  try {
    registry.touchLastSeen(cwdPosix, new Date().toISOString());
    const siblings = registry.list().filter((p) => p.repo_path !== cwdPosix);
    if (siblings.length) {
      const missing = siblings.filter((p) => !existsSync(p.repo_path)).length;
      registryLine = ` · ${siblings.length} sibling project${siblings.length === 1 ? '' : 's'}: ${siblings.map((p) => p.name).join(', ')}${missing ? ` (${missing} missing)` : ''}`;
    }
  } finally {
    registry.close();
  }
}

if (process.env.STERLING_NO_BANNER !== '1') {
  const width = Math.max(...BANNER_ROWS.map((r) => r.length));
  const version = pluginVersion();
  const versionLine = version ? `v${version}`.padStart(width) + '\n' : '';
  process.stderr.write(`${paint(BANNER_ROWS)}\n${versionLine}`);
}

const output = {
  systemMessage: `${counts.todos} todo${counts.todos === 1 ? '' : 's'} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending${registryLine}`,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONVENTIONS },
};
process.stdout.write(JSON.stringify(output));
allow();
