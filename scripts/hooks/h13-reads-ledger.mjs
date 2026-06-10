// H13 — reads ledger, H3's evidence collector (spec §6 H13). PostToolUse Read, non-blocking.
// Only Read of the exact file counts — Grep/Glob hits are not read-evidence.
import { readStdin, allow, warnNonBlocking, openStore, repoRel } from './lib/common.mjs';
import { ledgerPath, appendRead } from './lib/ledger.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow(); // outside the repo: no contract jurisdiction

const store = openStore(input.cwd);
let runId;
if (store) {
  try {
    runId = store.getRun()?.id;
  } finally {
    store.close();
  }
}

try {
  appendRead(ledgerPath(input.cwd, runId, input.agent_id), {
    agent_id: input.agent_id ?? 'conductor',
    path: rel,
    at: new Date().toISOString(),
  });
} catch (e) {
  warnNonBlocking(`H13: failed to append read-evidence for '${rel}': ${e.message}`);
}
allow();
