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
  {
    commit: 'bf3c13f7',
    date: '2026-10-03',
    reason: 'plan-the-order-at-intake gains the split-at-intake rule for a multi-area ask (decision board-asks-split-at-intake-into-mergeable-one-area-items)',
    before: 'a dependency the user states is given, never re-derived or second-guessed.',
    after: "a dependency the user states is given, never re-derived or second-guessed. When an ask spans several areas, do not board it as one bundle: board it as several items, each one reviewable and mergeable change touching one area's files with its own acceptance, linked by `blocked_by` in dependency order and sharing one `objective`, with the user's words verbatim on the first item. Split at natural dependency points and no finer, since each item costs one task-end review, one version bump and one merge. Smaller items block less, because blocking comes from dependencies and shared write paths and a bundle maximises both (decision `board-asks-split-at-intake-into-mergeable-one-area-items`, user-ruled 2026-10-03).",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): a subagent also gets hook-staged knowledge, only when one dispatch of its type is pending",
    before: "and your brief. Under-specified",
    after: "and your brief. A hook also stages the store's knowledge for the files the brief names, but only when exactly one dispatch of that agent type is pending; for parallel lanes of the same type, put the record ids in each brief (decision `h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar`). Under-specified",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): a code-touching brief carries the REVIEW-TERRITORY line H22 reads",
    before: "**Return** (the exact shape you want).",
    after: "**Return** (the exact shape you want). **Territory**: a code-touching brief also carries one `REVIEW-TERRITORY: [\"path\", …]` line of repo-relative paths; H22 reads it to record which files the lane owns.",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): the conductor scopes each record at creation (decision projects-mount-domains-and-sibling-projects)",
    before: "so the record is findable by the words a user would say.",
    after: "so the record is findable by the words a user would say. Scope each new record when you create it. A record about a subject one of the mounted domains describes takes `scope: domain:<name>`; a record about this repo, or one that carries `file_keys`, stays `project` (decision `projects-mount-domains-and-sibling-projects`). Promotion is a backstop for a record that was scoped wrong, not the normal path.",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): only the reconcile lane has a background worker; every other lane is the conductor's",
    before: "minted by the event that found it, removed by the artifact that closes it. Never hand-park",
    after: "minted by the event that found it, removed by the artifact that closes it. A background worker closes already-paid `reconcile_needed` items by itself, in batches of 5 or after 30 minutes, so \"worker not running\" at session start is normal. Every other lane (`state_review`, `promotion_review`, `refresh_reference`, `stale_research`, the capture and article lanes) and every `reconcile_needed` item the worker judged \"owes prose\" is yours. When H1 says the queue is deep, read the lane split before draining: only the reconcile lane has a worker. Never hand-park",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): H10 has a soft note at 35% as well as the 50% warning",
    before: "At 50% of the model's real window H10 warns you to **finish the open work and commit it** — not stop, not clear.",
    after: "H10 notes pressure at 35% and warns at 50% of the model's real window (the `context_watch.conductor` defaults); both mean **finish the open work and commit it** — not stop, not clear.",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): the H31 plan lock is stated for Claude Code",
    before: "updated at every slice boundary.\n",
    after: "updated at every slice boundary.\n\nAn approved plan is locked. H31 binds the plan the user approved at ExitPlanMode and H1 prints it as PLAN LOCK at every session start; follow it, and release it with `plan-lock.mjs --release --reason \"<why>\"` only when the user drops the plan.\n",
  },
  {
    commit: 'fix/conductor-runs-init-itself',
    date: '2026-10-03',
    reason: 'new bullet: the conductor runs Sterling init itself and never hands the init command to the user (user-ruled through the question form, "Add it"; GitHub issue #4)',
    before: "use only listed skills.\n",
    after: "use only listed skills.\n- **Run Sterling init yourself.** When a project needs init (a plugin cutover, a new project, a launcher still on `--plugin-dir`), run it; never print the init command for the user to run. Only an interactive login is a `! <command>` case (user-ruled 2026-10-03 through the question form, 'Add it', after a conductor handed the user a broken init command twice; GitHub issue #4).\n",
  },
  {
    commit: '6b71653c',
    date: '2026-10-04',
    reason: 'the merge path is named by its bundled bin/ entry, not scripts/direct-merge.mjs, which fails on an installed plugin copy (GitHub issue #16)',
    before: 'sanctioned merge path — `node scripts/direct-merge.mjs` via `/sterling:merge` — never',
    after: 'sanctioned merge path — `/sterling:merge`, which runs the bundled `bin/direct-merge.mjs` — never',
  },
  {
    commit: '8dd62782',
    date: '2026-10-04',
    reason: 'the rotation note is written by the bundled bin/ entry through the Sterling root the session start printed, not <clone>/scripts/rotation-note.mjs (GitHub issue #16)',
    before: '`node <clone>/scripts/rotation-note.mjs --next-slice "<exact next slice>" --lane "<agent type; files; what it found or changed; what is left>"`; H1 injects',
    after: '`node "<Sterling root>/bin/rotation-note.mjs" --next-slice "<exact next slice>" --lane "<agent type; files; what it found or changed; what is left>"` (the Sterling root is the path the STERLING ROOT line printed at session start; every `<Sterling root>` below means it); H1 injects',
  },
  {
    commit: '8dd62782',
    date: '2026-10-04',
    reason: 'the plan lock release is run through the bundled bin/ entry (GitHub issue #16)',
    before: 'release it with `plan-lock.mjs --release --reason "<why>"` only when',
    after: 'release it with `node "<Sterling root>/bin/plan-lock.mjs" --release --reason "<why>"` only when',
  },
  {
    commit: 'board b43ddc10',
    date: '2026-10-05',
    reason: 'the conductor owns the project\'s own full test suite and check command; `npm run check` is only what that is in a Node project with the script, because the template installs into projects of any stack (user-ruled, "Project lint and check commands")',
    before: 'You own the full suite and `npm run check`, run once,',
    after: 'You own the project\'s own full test suite and check command (`npm run check` in a Node project that has that script), run once,',
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
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): a capture candidate names its scope",
    before: "the conductor decides whether to write it, and writes it directly — never through you.\n",
    after: "the conductor decides whether to write it, and writes it directly — never through you. A capture candidate names its scope: `project` when it is about this repo's files, `domain:<subject>` when it is a fact about a subject other projects share (domain-scoped records carry no file_keys).\n",
  },
  {
    commit: '08476117',
    date: '2026-10-03',
    reason: "instruction audit (finding instruction-file-audit-against-code-and-rulings-october-2026): the output contract states the complete/blocked first line the Inputs section already requires",
    before: "# Output contract\n\n```text\nChanges:",
    after: "# Output contract\n\nThe first line is `complete` or `blocked`, followed by this block:\n\n```text\nChanges:",
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'new rubric item 3, the build-less-first order (user-ruled, board efd77feb); the items after it move down one number, highest first so no rewrite collides with another',
    before: '\n9. Sterling hook-delivered',
    after: '\n10. Sterling hook-delivered',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: the Sterling write-grant item (8 to 9)',
    before: '\n8. Your write grant is code and tests, not',
    after: '\n9. Your write grant is code and tests, not',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: the portable write-grant item (8 to 9)',
    before: '\n8. Your write grant is code and tests. If',
    after: '\n9. Your write grant is code and tests. If',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: clean up (7 to 8)',
    before: '\n7. Clean up as you go',
    after: '\n8. Clean up as you go',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: verify (6 to 7)',
    before: '\n6. Verify with commands',
    after: '\n7. Verify with commands',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: never ship weakened tests (5 to 6)',
    before: '\n5. Never ship weakened',
    after: '\n6. Never ship weakened',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'renumber for the new item 3: bug report (4 to 5)',
    before: '\n4. A bug report is',
    after: '\n5. A bug report is',
  },
  {
    commit: 'board efd77feb',
    date: '2026-10-05',
    reason: 'new rubric item 3: stop at the first that holds before writing new code (not needed, repo helper, standard library, installed dependency); never add a dependency for a few lines; never shortens the tests or the report (user-ruled, board efd77feb, finding a7138a10)',
    before: '\n3. Match the surrounding code',
    after: '\n3. Before writing new code, stop at the first that holds: it is not needed (say so in one line); a helper, type or pattern already in this repo does it; the standard library or a platform feature does it; an installed dependency does it. Never add a dependency for what a few lines can do. This never shortens the tests or the report.\n4. Match the surrounding code',
  },
  {
    commit: 'board b43ddc10',
    date: '2026-10-05',
    reason: 'the bug-fix rule asks for a regression test that fails without the fix, or a report that says why that could not be shown (user-ruled, "Regression test must fail first")',
    before: 'fix the cause, add a regression test. A fix',
    after: 'fix the cause, add a regression test that fails without the fix, or say in the report why that could not be shown. A fix',
  },
  {
    commit: 'board b43ddc10',
    date: '2026-10-05',
    reason: 'the report\'s Tests slot asks for the red-then-green evidence of a regression test (user-ruled, "Regression test must fail first")',
    before: '- what you added or updated, and what it proves\n',
    after: '- what you added or updated, and what it proves; for a regression test, that it failed before the fix and passes with it\n',
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
