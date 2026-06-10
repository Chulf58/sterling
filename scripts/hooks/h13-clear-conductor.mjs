// H13 lifecycle (spec §6 H13): direct-mode conductor ledger is cleared on every
// UserPromptSubmit — the conductor's read-evidence window is "since last user prompt" (P4).
import { readStdin, allow } from './lib/common.mjs';
import { ledgerPath, clearLedger } from './lib/ledger.mjs';

const input = readStdin();
clearLedger(ledgerPath(input.cwd, undefined, undefined));
allow();
