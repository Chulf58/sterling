// The prompt hook: a record selected in the dashboard is taken once from the
// store and appended to the next prompt, as H2 does on Claude Code.
import { join } from 'node:path';

/** H2's one-shot selection handoff: the pending selection row is consumed and added to the prompt text. */
export function createPromptHandler({ openStore, rootOf, fenced }) {
  return async function onPrompt(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('prompt', root, () => {
      // Checked before the take, so an unknown shape never consumes the selection.
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      let selection;
      try {
        selection = store.takeSelection();
      } finally {
        store.close();
      }
      if (!selection) return;
      input.prompt.text = `${input.prompt.text}\n\nTUI selection (one-shot): the user has selected ${selection.type} '${selection.record_id}'. Resolve the selected record via knowledge_get before answering.`;
    });
  };
}
