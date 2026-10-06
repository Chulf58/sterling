// H2 — selection inject (spec §6 H2, §11). UserPromptSubmit, non-blocking.
// One-shot consume of the selection ROW IN THE STORE (transactional
// read+delete) — P4 bans shared mutable transient files, including this one.
// The one exception is Postgres storage (decision
// postgres-store-backend-design-sync-bridge-schema-per-store, point 9): that
// store is shared across machines, so the slot is a file local to this
// checkout and host (lib/selection-file.mjs), and this hook never connects.
import { readStdin, allow, warnNonBlocking, openStore, storeBackend } from './lib/common.mjs';
import { takeSelectionFile } from './lib/selection-file.mjs';

const input = readStdin();
let selection;
if (storeBackend(input.cwd) === 'routed') {
  try {
    selection = takeSelectionFile(input.cwd);
  } catch (e) {
    warnNonBlocking(`H2: DEGRADED — ${(e && e.message) || e}.\n`);
  }
} else {
  const store = openStore(input.cwd);
  if (!store) allow();
  try {
    selection = store.takeSelection();
  } finally {
    store.close();
  }
}
if (!selection) allow();

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `TUI selection (one-shot): the user has selected ${selection.type} '${selection.record_id}'. Resolve the selected record via knowledge_get before answering.`,
    },
  })
);
allow();
