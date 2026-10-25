// The prompt hook: a record selected in the dashboard is taken once from the
// store and appended to the next prompt, as H2 does on Claude Code.
// With Postgres storage the slot is a file local to this checkout and host
// (scripts/hooks/lib/selection-file.mjs), not a store row, and no store is opened.
// The same file slot, at the checkout, serves a linked worktree on any storage: the
// shared store has one selection row, which belongs to the main checkout's dashboard,
// so a worktree prompt never takes it (the dashboard publishes to the worktree's file).
import { join } from 'node:path';
import { storeRootFor } from '../../../scripts/lib/worktree-root.mjs';
import { inWorkerChild } from './worker.mjs';
import { storeBackend } from '../../../scripts/hooks/lib/store-backend.mjs';
import { takeSelectionFile } from '../../../scripts/hooks/lib/selection-file.mjs';

/** H2's one-shot selection handoff: the pending selection row is consumed and added to the prompt text. */
export function createPromptHandler({ openStore, rootOf, fenced, env = process.env }) {
  return async function onPrompt(input) {
    // The selection is the user's: the maintenance worker child's prompt never takes it (worker.mjs inWorkerChild).
    if (inWorkerChild(env)) return;
    const root = rootOf();
    if (!root) return;
    await fenced('prompt', root, () => {
      // Checked before the take, so an unknown shape never consumes the selection.
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      let selection;
      const storeRoot = storeRootFor(root);
      if (storeRoot !== root || storeBackend(storeRoot) === 'routed') {
        selection = takeSelectionFile(root);
      } else {
        const store = openStore(join(root, '.sterling', 'sterling.db'));
        try {
          selection = store.takeSelection();
        } finally {
          store.close();
        }
      }
      if (!selection) return;
      input.prompt.text = `${input.prompt.text}\n\nTUI selection (one-shot): the user has selected ${selection.type} '${selection.record_id}'. Resolve the selected record via knowledge_get before answering.`;
    });
  };
}
