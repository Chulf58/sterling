// H16 — session-event register (spec §6, run r-0501). PostToolUse
// WebSearch|WebFetch|Task|Agent. Records research and agent-dispatch events
// to .sterling/transient/session-events.json in direct mode only.
// Pipeline-mode (active run): allow with NO write — the pipeline owns capture.
// Missing store: allow, no recording (fail-open, mirrors H7).
// Never deduplicates: the register is a pure append log.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, warnNonBlocking, openStore } from './lib/common.mjs';

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow();

try {
  const run = store.getRun();
  if (run) allow(); // pipeline: silent, no write — pipeline owns capture (AC6)

  // direct mode: derive kind + detail from the tool call, then append
  const tool = input.tool_name;
  let kind, detail;
  if (tool === 'WebSearch') {
    kind = 'research_tool';
    detail = String(input.tool_input?.query ?? '');
  } else if (tool === 'WebFetch') {
    kind = 'research_tool';
    detail = String(input.tool_input?.url ?? '');
  } else {
    // Task or Agent
    kind = 'agent_dispatch';
    detail = String(input.tool_input?.subagent_type ?? '');
  }

  const eventsPath = join(input.cwd, '.sterling', 'transient', 'session-events.json');
  mkdirSync(dirname(eventsPath), { recursive: true });
  const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  events.push({ kind, detail, at: new Date().toISOString() });
  writeFileSync(eventsPath, JSON.stringify(events));
  allow();
} catch (e) {
  warnNonBlocking(`H16: session-event registration failed: ${e.message}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
