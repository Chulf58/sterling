// H19 drain — the 'prompt' rung's injection surface (decision 6dfbe675).
// UserPromptSubmit is the one additionalContext seam PROVEN on this platform
// (H2). File-touch enqueues; this drains one-shot (read+delete, P4) and
// injects everything pending. One-turn lag is the rung's known cost — the
// probe-set 'read'/'edit' rungs remove it when the platform supports them.
// The read-evidence window resets per prompt (below); the delivery guard
// deliberately does NOT (whole-session TTL — h19-clear-session at
// SessionStart is its lifecycle event).
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { pendingPath, drainPending } from './lib/delivery.mjs';
import { ledgerPath, pruneUnhashed } from './lib/ledger.mjs';

const input = readStdin();
try {
  // H13 FOLD (2026-08-30, decision 04982f45): drop the conductor read-
  // ledger's HASHLESS legacy entries on every prompt — the other prompt-time
  // maintenance drain, folded here for thematic fit (h2-selection-inject
  // stays single-purpose; decision 04982f45 rejects that alternative).
  // Hashless entries are still mintable today (fileHash undefined on an
  // unreadable file at read time) and their per-prompt expiry is the
  // deliberate fallback window — deleting this call would make that
  // evidence immortal, a regression of H3's read-evidence discipline. Wrapped
  // separately (no exit) so a prune failure cannot cost the drain's own
  // pending-delivery work below.
  try {
    pruneUnhashed(ledgerPath(input.cwd, undefined, undefined));
  } catch (e) {
    process.stderr.write(`H19 drain: ledger prune failed: ${(e && e.message) || e}\n`);
  }

  const entries = drainPending(pendingPath(input.cwd));
  if (!entries.length) allow();
  const context = entries.map((e) => e.payload).join('\n\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  allow();
} catch (e) {
  warnNonBlocking(`H19 drain: pending delivery failed: ${(e && e.message) || e}`);
}
