// H2 — selection inject (spec §6 H2, §11). UserPromptSubmit, non-blocking.
// One-shot consume of the selection ROW IN THE STORE (transactional
// read+delete) — P4 bans shared mutable transient files, including this one.
import { readStdin, allow, openStore } from './lib/common.mjs';

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow();

let selection;
try {
  selection = store.takeSelection();
} finally {
  store.close();
}
if (!selection) allow();

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `TUI selection (one-shot): the user has selected ${selection.type} '${selection.record_id}'. Resolve it via knowledge_get (records) or run_state (runs/phases) before answering.`,
    },
  })
);
allow();
