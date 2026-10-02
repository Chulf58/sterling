// The compaction hook: the session's delivery receipts are removed.
import { rmSync } from 'node:fs';
import { deliverySessionDir } from '../../../scripts/hooks/lib/delivery.mjs';

/**
 * Compaction can drop a delivered article from the model's window, so the
 * session's delivery receipts go with it and delivery fires again, as
 * h19-clear-session does on Claude Code. Never sets input.result.
 */
export function createCompactionHandler({ rootOf, fenced }) {
  return async function onCompaction(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('compaction', root, () => {
      const dir = deliverySessionDir(root, input?.sessionID);
      if (!dir) throw new Error(`compaction input has no usable sessionID (${typeof input?.sessionID}); delivery receipts were not reset`);
      rmSync(dir, { recursive: true, force: true });
    });
  };
}
