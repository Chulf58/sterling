// H32 — pending answers (PostToolUse, matcher AskUserQuestion). Appends the answered
// question form to .sterling/transient/pending-answers.json; the next prompt's H19 drain
// says how many are unrecorded. Never blocks: a failed write is warned, not denied.
// Decision answered-question-forms-are-kept-as-pending-answers-in-a-tra.
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { appendPendingAnswer, entryFromClaude } from './lib/pending-answers.mjs';

const input = readStdin();
try {
  const entry = input.tool_name === 'AskUserQuestion' ? entryFromClaude(input) : null;
  if (entry) appendPendingAnswer(input.cwd, entry);
} catch (e) {
  warnNonBlocking(`H32 pending answers failed: ${(e && e.message) || e}`);
}
allow();
