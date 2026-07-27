// H9 — run capture BACKSTOP (spec §6 H9). Stop, blocks only while
// machine_state = completing. THE GATE LIVES IN dispose-run (invariant 6) —
// this hook catches the failure the script can't see: a script only runs when
// invoked; Stop fires no matter what. Outstanding items come from the same
// promotion-condition definition dispose-run enforces.
import { readStdin, deny, allow, openStore, loadConfig } from './lib/common.mjs';
import { verifyPromotionConditions } from '../lib/promotion.mjs';

const input = readStdin();
if (input.stop_hook_active) allow(); // loop guard: a prior Stop block already continued the conversation

// F5 class (anti_pattern af5382e4): a BLOCKING gate that cannot evaluate must DENY,
// never void itself via a non-blocking exit 1. openStore throws on a corrupt db and
// loadConfig throws on a malformed config, so BOTH live inside the try. deny()/allow()
// process.exit before reaching the catch, so control flow is unaffected; the
// stop_hook_active loop guard above bounds a fail-closed stop to one denial.
try {
  const store = openStore(input.cwd);
  if (!store) allow();

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
} catch (e) {
  deny(
    `H9: completion backstop could not evaluate the run (${(e && e.message) || e}) — failing closed (P5); ` +
      'fix the store/config, then stop again.'
  );
}
