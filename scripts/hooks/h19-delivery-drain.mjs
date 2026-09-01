// H19 drain — the 'prompt' rung's injection surface (decision 6dfbe675).
// UserPromptSubmit is the one additionalContext seam PROVEN on this platform
// (H2). File-touch enqueues; this drains one-shot (read+delete, P4) and
// injects everything pending. One-turn lag is the rung's known cost — the
// probe-set 'read'/'edit' rungs remove it when the platform supports them.
// The read-evidence window resets per prompt (below); the delivery guard
// deliberately does NOT (whole-session TTL — h19-clear-session at
// SessionStart is its lifecycle event).
import { readStdin, allow, warnNonBlocking, openStore } from './lib/common.mjs';
import { pendingPath, drainPending, renderDrainEntry } from './lib/delivery.mjs';
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

  // RENAME-BASED CLAIM (fixer F2). drainPending takes the producers' queue lock,
  // RENAMES pending.json to a claimed-*.json it now owns, and releases the lock
  // at once — so an enqueue racing this drain can never be deleted with the
  // batch, and the store re-resolve below runs OUTSIDE the lock rather than
  // holding it for the whole re-read. If the lock is not granted the drain is
  // SKIPPED entirely (loud on stderr, queue intact) — never an unlocked mutation.
  //
  // PROCESS THEN DELETE: `release()` removes the claimed file(s) only AFTER the
  // payload has been written below, so a crash in between re-serves the batch on
  // the next drain instead of losing it (the accepted direction of failure —
  // a possible duplicate delivery, see lib/delivery.mjs's claim comment).
  const { entries, release } = drainPending(pendingPath(input.cwd));
  if (!entries.length) {
    release();
    allow();
  }

  // RE-RESOLVE (decision db3392db part 2). The rung's one-turn lag means a
  // queued pointer can name a ruling that was superseded, retired or deleted
  // since the touch, and until now the pre-rendered payload was replayed
  // verbatim — the only delivery surface that could serve a dead ruling as live.
  //
  // ONE STORE CONNECTION for the whole batch: opened once here, never per entry,
  // so a 30-entry drain costs one open. Opening it is a NEW cost on this hook (it
  // held no store handle before) and an accepted one. It is a CONNECTION, not a
  // snapshot: every id is read individually as its entry renders, so a write
  // landing mid-drain can still be seen by a later entry and not an earlier one.
  // Sharing one connection NARROWS that window, it does not eliminate it — and
  // that is acceptable here because each verdict is only ever "what the store says
  // about this id, read once, disclosed as read".
  //
  // FAIL-OPEN, both store-absent arms distinguished (P5): openStore returns null
  // for an ABSENT db and THROWS for an UNREADABLE one. Delivery is an aid, never
  // a gate, so both degrade to the stored payload plus an UNVERIFIED banner and
  // the drain still completes — never silence, never an indefinite requeue.
  let store = null;
  let storeReason;
  try {
    store = openStore(input.cwd);
    if (!store) storeReason = 'no Sterling store is present at this path, so the queued ids could not be re-read';
  } catch (e) {
    store = null;
    storeReason = `the Sterling store could not be opened (${(e && e.message) || e}), so the queued ids could not be re-read`;
  }

  // APPEND ORDER PRESERVED and NO CROSS-ENTRY DEDUP: a plain in-order map, one
  // rendering per entry, with no drain-wide record cache — two entries naming
  // one record both serve it, because full deliveries, Bash pointers and H23
  // dedup in deliberately different namespaces. renderDrainEntry never throws,
  // which is what contains a per-entry failure to that entry.
  const context = entries.map((e) => renderDrainEntry(store, e, storeReason)).join('\n\n');

  // DELETE ONLY FROM THE WRITE-COMPLETION CALLBACK (fixer H2 remainder). `allow()`
  // is a bare process.exit(0) (lib/common.mjs:113), and process.stdout.write is
  // NOT synchronous on every platform — Node documents pipes as asynchronous on
  // Windows (synchronous only on Linux/macOS), and stdout here is a pipe to the
  // CLI. Deleting the claimed batch on the line after write() therefore raced the
  // flush: exit(0) could truncate the injection AFTER the only recoverable copy
  // was gone, which is LOSS, not the accepted duplicate direction of failure.
  //
  // THE INVARIANT, at every crash/truncation point: the claimed batch still exists
  // ⇒ the next drain re-serves it. So exit is deferred to the callback, and if the
  // write ERRORS the batch is deliberately left claimed. If the callback somehow
  // never runs, the process ends when the event loop drains with release()
  // UNCALLED — which fails in the safe direction by construction.
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
    (err) => {
      if (err) {
        // Loud, non-fatal: delivery is an aid, never a gate, so a failed injection
        // still exits 0 — but the batch stays claimed so nothing is lost.
        process.stderr.write(
          `H19 drain: writing the drained batch failed (${(err && err.message) || err}) — batch left CLAIMED for the next prompt\n`
        );
        process.exit(0);
      }
      release(); // flushed: only now is the claimed file disposable (P4)
      process.exit(0);
    }
  );
} catch (e) {
  warnNonBlocking(`H19 drain: pending delivery failed: ${(e && e.message) || e}`);
}
