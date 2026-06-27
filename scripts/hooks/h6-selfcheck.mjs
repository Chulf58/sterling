// H6 startup self-check (spec §6 H6): at SessionStart, confirm a usage object
// is parseable from the conductor's transcript tail. Only FORMAT DRIFT —
// assistant entries present but no readable usage (format_unparseable) — degrades
// H6 LOUDLY: check_skipped {context-watch, format_unparseable}; runs proceed.
// A MISSING transcript (fresh startup, before the file exists) or one with no
// assistant entries yet is NORMAL, not a failure: there is nothing to parse,
// which says nothing about whether the format drifted. Flagging those produced a
// false "self-check failed" on every fresh launch.
import { readStdin, allow, openStore } from './lib/common.mjs';
import { latestUsage } from './lib/transcript.mjs';

const input = readStdin();
const { usage, reason } = latestUsage(input.transcript_path);

if (!usage && reason === 'format_unparseable') {
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
