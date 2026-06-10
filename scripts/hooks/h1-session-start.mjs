// H1 — conventions + banner (spec §6 H1). SessionStart, non-blocking.
// Conventions go to Claude as additionalContext; the banner + board/
// maintenance counts go to the human as systemMessage — the queue is
// event-drained and otherwise invisible; this is its visibility pressure.
import { readStdin, allow, openStore } from './lib/common.mjs';

const CONVENTIONS = [
  'Sterling conventions (injected by H1):',
  '- Anti-speculation: never invent an API, field, flag, or behavior; cite tool-call evidence from this turn or say "I don\'t know, checking" and check.',
  '- No false action claims: never imply something was saved, run, or recorded unless it was actually performed this turn.',
  '- Canonical naming: one name per concept, from the registries; phase execution, intake, steps — kill synonyms on sight.',
].join('\n');

// swappable art slot (§6 H1); width-aware fallback is the plain name
const BANNER_ART = 'STERLING';

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

const suppressBanner = process.env.STERLING_NO_BANNER === '1';
const banner = suppressBanner ? '' : `${BANNER_ART} — `;
const output = {
  systemMessage: `${banner}${counts.todos} todo${counts.todos === 1 ? '' : 's'} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending`,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONVENTIONS },
};
process.stdout.write(JSON.stringify(output));
allow();
