// H6 — context watcher, usage-read, never token-count (spec §6 H6).
// PostToolUse * (compute + record) and PreToolUse * (enforce) share this script.
// Mode observe|enforce from config (MVP-spine default: observe — record fills,
// skip the deny). Unparseable usage degrades LOUDLY via check_skipped
// {context-watch}; runs proceed.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, deny, loadConfig, openStore } from './lib/common.mjs';
import { deriveAgentTranscript, latestUsage, fillPct } from './lib/transcript.mjs';

const input = readStdin();
// The conductor's own fill comes from the native statusline (§6 H6) — H6 watches spawned agents.
if (!input.agent_id) allow();

const config = loadConfig(input.cwd);
const cw = {
  warn_pct: 60,
  block_pct: 95,
  mode: 'observe',
  windows: { default: 200_000 },
  ...(config?.context_watch ?? {}),
};

const store = openStore(input.cwd);
const run = store ? store.getRun() : undefined;
const now = new Date().toISOString();

function recordSkip(reason) {
  if (store) store.recordCheckSkipped('context-watch', reason, run?.id, now);
}

try {
  const transcript = deriveAgentTranscript(input.transcript_path, input.agent_id);
  const { usage, model, reason } = latestUsage(transcript);
  if (!usage) {
    recordSkip(reason ?? 'format_unparseable');
    process.stderr.write(`H6 degraded loudly: ${reason} for agent ${input.agent_id} (recorded check_skipped {context-watch})`);
    allow();
  }
  const windowSize = (model && cw.windows[model]) || cw.windows.default;
  const fill = fillPct(usage, windowSize);

  if (input.hook_event_name === 'PostToolUse') {
    const fillsPath = run
      ? join(input.cwd, '.sterling', 'runs', run.id, 'h6-fills.jsonl')
      : join(input.cwd, '.sterling', 'transient', 'h6-fills.jsonl');
    mkdirSync(dirname(fillsPath), { recursive: true });
    appendFileSync(
      fillsPath,
      JSON.stringify({ agent_id: input.agent_id, agent_type: input.agent_type, fill_pct: fill, model, at: now }) + '\n'
    );
    if (fill >= cw.warn_pct && run) {
      store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: input.agent_id, fill_pct: fill, at: now });
    }
  }

  if (input.hook_event_name === 'PreToolUse' && fill >= cw.block_pct && cw.mode === 'enforce') {
    deny(
      `H6: context fill ${fill.toFixed(1)}% ≥ ${cw.block_pct}% for agent ${input.agent_id} — stop now and exit phase-overflow {fill_pct: ${fill.toFixed(1)}}; work past this point is rejected, not salvaged (P7)`
    );
  }
  allow();
} finally {
  if (store) store.close();
}
