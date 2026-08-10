// H13 lifecycle (spec §6 H13, refined by board 776d2b65): on every
// UserPromptSubmit the conductor ledger drops its HASHLESS legacy entries only.
// Hashed entries expire when the FILE CHANGES (H3 compares the entry's
// read-time content hash against the current bytes), which is the truth the
// old whole-ledger clear only approximated — wiping evidence for byte-current
// files cost a measured ~7 forced re-reads in one session. Compaction, the
// other expiry driver, is handled where it actually surfaces: H1 clears this
// ledger on SessionStart source=compact.
import { readStdin, allow } from './lib/common.mjs';
import { ledgerPath, pruneUnhashed } from './lib/ledger.mjs';

const input = readStdin();
pruneUnhashed(ledgerPath(input.cwd, undefined, undefined));
allow();
