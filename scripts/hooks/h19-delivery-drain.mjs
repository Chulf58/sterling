// H19 drain — the 'prompt' rung's injection surface (decision fe62546f).
// UserPromptSubmit is the one additionalContext seam PROVEN on this platform
// (H2). File-touch enqueues; this drains one-shot (read+delete, P4) and
// injects everything pending. One-turn lag is the rung's known cost — the
// probe-set 'read'/'edit' rungs remove it when the platform supports them.
// Ordered AFTER h13-clear-conductor in hooks.json: the read-evidence window
// resets per prompt; the delivery guard deliberately does NOT (whole-session
// TTL — h19-clear-session at SessionStart is its lifecycle event).
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { pendingPath, drainPending } from './lib/delivery.mjs';

const input = readStdin();
try {
  const entries = drainPending(pendingPath(input.cwd));
  if (!entries.length) allow();
  const context = entries.map((e) => e.payload).join('\n\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  allow();
} catch (e) {
  warnNonBlocking(`H19 drain: pending delivery failed: ${(e && e.message) || e}`);
}
