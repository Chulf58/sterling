// The deliberate wording edits made to agent-templates/conductor.md after the commits
// that two tests pin its Claude render to:
//   - scripts/tests/opencode-host-render.test.mjs (baseline 9c7533f, before the host fences)
//   - scripts/tests/portable-agents.test.mjs (baseline 0e5a9fe, before the host fences)
// Both tests prove that the host fences and the render change nothing in the Claude-facing
// text beyond deliberate wording edits. They apply this list to the baseline text first,
// then assert byte-equality with the current Claude render. A wording edit is not a
// regression, so it is listed here, never absorbed by moving a baseline or loosening an
// assertion.
//
// The next deliberate conductor.md wording edit that reaches the Claude render adds an
// entry here: [before, after] with the commit sha and a one-line reason. Each `before`
// must occur exactly once in the baseline, so a stale entry fails loudly.
import assert from 'node:assert/strict';

export const CONDUCTOR_WORDING_EDITS = [
  {
    commit: 'f55f9f0',
    date: '2026-10-02',
    reason: 'a task notification carrying no report gets no visible reply (user-ruled, "Silent"), not a one-word "Ack"',
    before: 'A task notification carrying no report — the interim "has not reported yet / waiting on its own background work" stop — gets at most a one-word acknowledgement, never a status block; a lane runs',
    after: 'A task notification carrying no report (the interim "has not reported yet / waiting on its own background work" stop, and the completion notice that follows a lane\'s hand-back message) gets no visible reply at all: no "Ack", no status block. End the turn without text (user-ruled 2026-10-02 through the question form, "Silent", because a one-word "Ack" after every lane looked broken to the reader). A lane runs',
  },
  {
    commit: 'a6ba3a4',
    date: '2026-10-02',
    reason: 'new bullet: an offer is a question and never ends a reply (user-ruled, "Add to conductor.md")',
    before: '\n- When the conversation grows long its earlier part is summarized',
    after: '\n- An offer is a question. A line such as "I can check if you want" or "want me to…?" is a prose question and does not count as asked. If the work is reversible and needs no authorization, do it; otherwise put it through the question form. Never end a reply on an offer (user-ruled 2026-10-02 through the question form, "Add to conductor.md": *"A question not asked using the question form doesnt count as asked"*, after a closing offer went out in prose).\n- When the conversation grows long its earlier part is summarized',
  },
  {
    commit: '81e8bf3',
    date: '2026-10-02',
    reason: 'Opus, not Fable, is the fallback reviewer while Sol is capped (user-ruled, "Opus as fallback")',
    before: '(Fable while Sol is capped, Opus when Terra executed the work)',
    after: '(Opus while Sol is capped and when Terra executed the work; user-ruled 2026-10-02 through the question form, "Opus as fallback": *"Fable is quite overkill"*)',
  },
];

const occurrences = (text, needle) => text.split(needle).length - 1;

// Applies every listed edit to a baseline conductor.md. Throws if an entry's `before`
// does not occur exactly once, so an entry that no longer matches its baseline fails.
export function applyConductorWordingEdits(baselineText) {
  let text = baselineText;
  for (const { commit, before, after } of CONDUCTOR_WORDING_EDITS) {
    assert.equal(occurrences(text, before), 1, `wording edit ${commit}: its "before" text must occur exactly once in the baseline`);
    text = text.replace(before, () => after);
  }
  return text;
}
