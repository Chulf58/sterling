// H15 — store write-path guard (spec §6 H15). PreToolUse Bash|PowerShell,
// BLOCKING. Any shell command referencing the project store (.sterling/ path
// or sterling.db) is denied — reads included — unless it invokes a sanctioned
// script/launcher (config store_guard.allow_scripts). The store is read and
// written through the §10 MCP tool surface ONLY; the deny message teaches the
// right path. Patterns grow incident-by-incident via config, never
// speculatively (adjudicated 2026-06-12 after a live conductor bypass).
// Deliberately store-free: the guard must run even when the store is exactly
// what is being protected.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, loadConfig } from './lib/common.mjs';
import { parseConfig } from '@sterling/schemas';

const input = readStdin();
if (!input.cwd || !existsSync(join(input.cwd, '.sterling'))) allow(); // not a Sterling project — no ceremony (P1)

const command = String(input.tool_input?.command ?? '');
// Bare `.sterling` (rm -rf/mv/tar of the whole store dir) must trip the gate too;
// the lookahead keeps suffixed names (.sterling-backups, .sterling2) out of it.
if (!/\.sterling(?![\w.-])|sterling\.db/i.test(command)) allow();

// a malformed config must fail CLOSED on the protected branch — an uncaught
// throw exits non-2, which the platform treats as non-blocking (a voided gate)
let allowScripts;
try {
  allowScripts = parseConfig(loadConfig(input.cwd) ?? {}).store_guard.allow_scripts;
} catch (e) {
  deny(`H15: store access denied — .sterling/config.json is unreadable (${e.message}); fix the config, the gate fails closed.`);
}
if (allowScripts.some((s) => command.includes(s))) allow();

deny(
  'H15: shell access to the Sterling store is denied — the store is read and written through the §10 MCP tool surface ONLY.\n' +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / note_remove / maintenance_enqueue / run_signal / agent_exit.\n' +
    `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts).\n` +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
);
