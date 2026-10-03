// The deliberate edits made to agent-templates/conductor.md and agent-templates/implementor.md
// after the commits that the tests pin their Claude renders to. Conductor first:
//   - scripts/tests/opencode-host-render.test.mjs (baseline 9c7533f, before the host fences)
//   - scripts/tests/portable-agents.test.mjs (baseline 0e5a9fe, before the host fences)
// Both tests prove that the host fences and the render change nothing in the Claude-facing
// text beyond deliberate wording edits. They apply this list to the baseline text first,
// then assert byte-equality with the current Claude render. A wording edit is not a
// regression, so it is listed here, never absorbed by moving a baseline or loosening an
// assertion.
//
// The same holds for implementor.md, which scripts/tests/portable-agents.test.mjs pins to
// 201a0bc (IMPLEMENTOR_WORDING_EDITS below).
//
// The next deliberate edit to either template that reaches the Claude render adds an
// entry to that template's list: [before, after] with the commit sha and a one-line
// reason. Each `before` must occur exactly once in the baseline, so a stale entry fails
// loudly.
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
  {
    commit: 'e82a184',
    date: '2026-10-03',
    reason: 'the grill skill also runs at intake on an ambiguous ask (user-ruled, "On ambiguity, at intake (Recommended)")',
    before: 'A consequential choice (scope, acceptance, architecture, an expensive commitment) that the store cannot settle goes to the user through the `grill` skill (`/sterling:grill`), and you name that choice before starting it (decision `sterling-grill-skill-design`).',
    after: 'For every new non-trivial ask, before the first dispatch, check whether the intent, the acceptance or the scope is unstated, or whether the ask has two or more reasonable readings. If any holds, run a short `grill` first (`/sterling:grill`, usually 1-3 questions, one at a time through the question form); its first question restates your understanding as an option, "Proceed as I understand it: ...". A clear ask starts at once; a vague one always gets the grill (user-ruled 2026-10-03 through the question form, "On ambiguity, at intake (Recommended)", after *"TGhe grill-me skills is super good. How do we use it more often to also drill intro requests/new tasks, understand intent, explain something vague"*). The older trigger still applies: a consequential choice (scope, acceptance, architecture, an expensive commitment) that the store cannot settle, met mid-task, goes to the same skill, and you name that choice before starting it (decision `sterling-grill-skill-design`).',
  },
  {
    commit: 'aa402b1',
    date: '2026-10-03',
    reason: 'conductor points at the CLAUDE.md record-authoring rule when it creates records (decision make-records-findable-authoring-rule-disclosure-lint-then-blind-experiment)',
    before: "the librarian's grant is for text you drafted, never for a new record.",
    after: "the librarian's grant is for text you drafted, never for a new record. Write every title, trigger and statement to the CLAUDE.md rule \"Author records to be found\", so the record is findable by the words a user would say.",
  },
  {
    commit: 'bebb276',
    date: '2026-10-03',
    reason: 'plan-the-order-at-intake gains needs, the three H1 groups and the delegation.max_concurrent ceiling (decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start)',
    before: 'Then dispatch every item that is not blocked and shares no write path with another, all in the same response.',
    after: 'Then dispatch every item that is not blocked and shares no write path with another, all in the same response, up to the lane ceiling `delegation.max_concurrent` (a ceiling, never a quota). An item\'s `needs` says what it waits on besides its blockers: `investigation` still starts, as a researcher lane only, never an implementor; `user` and `grill` wait for the user; absent means nothing. Set `needs` at intake when an item cannot start on its own, and clear it (`needs: ""`) once the user has answered. H1 prints three groups at session start and after a clear (READY, READY FOR RESEARCH, WAITING ON YOU), and H20 adds one `BOARD READY` line at your next dispatch when the ready set has changed. At session start and each time a lane lands, fill free lanes from READY and READY FOR RESEARCH up to the ceiling, never past it (decision `board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start`).',
  },
];

export const IMPLEMENTOR_WORDING_EDITS = [
  {
    commit: '7f34f5b',
    date: '2026-10-03',
    reason: 'new MCP tool domain_describe (Domains D2) is denied to the implementor under both prefixes; store writes stay the conductor\'s',
    before: ', mcp__sterling__capture_pending, mcp__plugin_sterling_sterling__capture_pending\n',
    after: ', mcp__sterling__capture_pending, mcp__plugin_sterling_sterling__capture_pending, mcp__sterling__domain_describe, mcp__plugin_sterling_sterling__domain_describe\n',
  },
];

const occurrences = (text, needle) => text.split(needle).length - 1;

// Applies a list of edits to a baseline template. Throws if an entry's `before` does not
// occur exactly once, so an entry that no longer matches its baseline fails.
function applyWordingEdits(edits, baselineText) {
  let text = baselineText;
  for (const { commit, before, after } of edits) {
    assert.equal(occurrences(text, before), 1, `wording edit ${commit}: its "before" text must occur exactly once in the baseline`);
    text = text.replace(before, () => after);
  }
  return text;
}

export const applyConductorWordingEdits = (baselineText) => applyWordingEdits(CONDUCTOR_WORDING_EDITS, baselineText);
export const applyImplementorWordingEdits = (baselineText) => applyWordingEdits(IMPLEMENTOR_WORDING_EDITS, baselineText);
