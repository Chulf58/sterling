// H6 startup self-check (spec §6 H6): at SessionStart, confirm a usage object
// is parseable from the conductor's transcript tail. Failure -> H6 degraded
// LOUDLY: check_skipped {context-watch, format_unparseable}; runs proceed.
// A fresh session with no assistant entries yet is not a failure (nothing to parse).
import { readStdin, allow, openStore } from './lib/common.mjs';
import { latestUsage } from './lib/transcript.mjs';

const input = readStdin();
const { usage, reason } = latestUsage(input.transcript_path);

if (!usage && reason !== 'no_assistant_entries') {
  const store = openStore(input.cwd);
  if (store) {
    try {
      store.recordCheckSkipped('context-watch', reason ?? 'format_unparseable', store.getRun()?.id, new Date().toISOString());
    } finally {
      store.close();
    }
  }
  process.stderr.write(`H6 self-check failed (${reason}): context watching degraded loudly — recorded check_skipped {context-watch}`);
}
allow();
