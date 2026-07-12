// H6 startup self-check (spec §6 H6): at SessionStart, confirm a usage object
// is parseable from the conductor's transcript tail. FORMAT DRIFT degrades H6
// LOUDLY: check_skipped {context-watch, <reason>}; runs proceed. Loud reasons:
// format_unparseable (assistant entries present, usage unreadable),
// window_exhausted (a 1MB tail with older bytes and no assistant entry), and —
// since R2 board 92c78bdd — no_assistant_entries on a SUBSTANTIAL transcript
// (> 256KB): a resumed session with zero parseable assistant entries is the
// TYPE-level drift class this canary exists for, previously indistinguishable
// from a fresh file. A MISSING transcript or an empty/small assistant-less one
// is NORMAL (fresh startup) — flagging those cried wolf on every launch.
import { statSync } from 'node:fs';
import { readStdin, allow, openStore } from './lib/common.mjs';
import { latestUsage } from './lib/transcript.mjs';

const SUBSTANTIAL_BYTES = 256 * 1024;

const input = readStdin();
const { usage, reason } = latestUsage(input.transcript_path);

let substantialNoAssistant = false;
if (!usage && reason === 'no_assistant_entries') {
  try {
    substantialNoAssistant = statSync(input.transcript_path).size > SUBSTANTIAL_BYTES;
  } catch {
    substantialNoAssistant = false;
  }
}

if (!usage && (reason === 'format_unparseable' || reason === 'window_exhausted' || substantialNoAssistant)) {
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
