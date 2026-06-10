// H9 — run capture BACKSTOP (spec §6 H9). Stop, blocks only while
// machine_state = completing. THE GATE LIVES IN dispose-run (invariant 6) —
// this hook catches the failure the script can't see: a script only runs when
// invoked; Stop fires no matter what. Outstanding items come from the same
// promotion-condition definition dispose-run enforces.
import { readStdin, deny, allow, openStore, loadConfig } from './lib/common.mjs';
import { verifyPromotionConditions } from '../lib/promotion.mjs';

const input = readStdin();
if (input.stop_hook_active) allow(); // loop guard: a prior Stop block already continued the conversation

const store = openStore(input.cwd);
if (!store) allow();

try {
  const run = store.getRun();
  // awaiting_merge_gate is legitimate stopping (the human decides at leisure);
  // rejected/merged/halted/running never trap the conductor (§6 H9).
  if (!run || run.machine_state !== 'completing') allow();

  const config = loadConfig(input.cwd) ?? {};
  const { refusals } = verifyPromotionConditions({ store, config, run });
  const outstanding = refusals.filter((r) => !r.startsWith('wrong_state'));
  deny(
    `H9: run '${run.id}' is mid-completion (machine_state 'completing') — resume the completion sequence instead of abandoning it.\n` +
      (outstanding.length
        ? `Outstanding promotion conditions:\n  ${outstanding.join('\n  ')}\nComplete capture, then run dispose-run.`
        : 'All promotion conditions look satisfied — run scripts/dispose-run.mjs to dispose and advance to the merge gate.')
  );
} finally {
  store.close();
}
