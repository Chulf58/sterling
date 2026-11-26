// H32 — pending answers (PostToolUse, matcher AskUserQuestion). Appends the answered
// question form to the checkout's .sterling/transient/pending-answers.json; the next prompt's
// H19 drain says how many are unrecorded. Never blocks: a failure is warned, not denied, and a
// directory that is not a Sterling project is left untouched.
// Decision answered-question-forms-are-kept-as-pending-answers-in-a-tra.
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { hookRoots } from './lib/hook-roots.mjs';
import { appendPendingAnswer, entryFromClaude } from './lib/pending-answers.mjs';

try {
  const input = readStdin();
  if (input.tool_name === 'AskUserQuestion' && hookRoots(input.cwd)) {
    const entry = entryFromClaude(input);
    if (entry) appendPendingAnswer(input.cwd, entry);
  }
} catch (e) {
  warnNonBlocking(`H32 pending answers failed: ${(e && e.message) || e}`);
}
allow();
