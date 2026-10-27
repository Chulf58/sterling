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
// librarian.md is pinned there to c7c0d012 (LIBRARIAN_WORDING_EDITS below).
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
  {
    commit: 'GitHub #56',
    date: '2026-10-09',
    reason: 'the background worker drains five lanes, writes small factual refreshes and hands the rest off as needs_conductor (decision maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet)',
    before: 'A background worker closes already-paid `reconcile_needed` items by itself, in batches of 5 or after 30 minutes, so \"worker not running\" at session start is normal. Every other lane (`state_review`, `promotion_review`, `refresh_reference`, `stale_research`, the capture and article lanes) and every `reconcile_needed` item the worker judged \"owes prose\" is yours. When H1 says the queue is deep, read the lane split before draining: only the reconcile lane has a worker.',
    after: 'A background worker drains `reconcile_needed`, `state_review`, `stale_research`, `refresh_reference` and `article_missing` by itself, once 5 items are eligible or the oldest has waited 30 minutes, so \"worker not running\" at session start is normal. It closes already-paid items and writes small factual refreshes, and hands the rest to you as `needs_conductor` with a reason. Every other lane, such as `promotion_review`, `deletion_candidate` and `capture_owed`, and every handed-off item is yours. When H1 says the queue is deep, read the lane split before draining: only the five worker lanes have a worker.',
  },
  {
    commit: 'GitHub #68',
    date: '2026-10-11',
    reason: 'a closing summary never lists askable questions as owed, open or pending; each goes through the question form first, and only a question whose evidence does not exist yet waits, on its board item (user-reported in GitHub issue #68, 2026-10-11)',
    before: 'after a closing offer went out in prose).\n',
    after: 'after a closing offer went out in prose). The same holds for a closing summary: it never lists questions as owed, open or pending. Each askable question goes through the question form, one at a time, before the summary is written. Only a question whose evidence does not exist yet may wait, and it waits on its board item (`needs: user`), never in prose (user-reported in GitHub issue #68, 2026-10-11: a reply listed three design questions as owed and ended on its ready line; asked through the form, all three were ruled within minutes).\n',
  },
  {
    commit: 'GitHub #68',
    date: '2026-10-11',
    reason: 'an askable question that has not gone through the question form blocks the ready line (user-reported in GitHub issue #68, 2026-10-11)',
    before: 'the user is the one who runs the clear. If something is still in flight, name it instead and do not print the line.',
    after: 'the user is the one who runs the clear. If something is still in flight, name it instead and do not print the line. An askable question that has not gone through the question form counts as in flight.',
  },
  {
    commit: 'GitHub #79',
    date: '2026-10-12',
    reason: 'a started task is owed until its end state, and an outside wait is left only to something that will wake the conductor, never a detached process (GitHub issue #79, 2026-10-12)',
    before: 'carry on with whatever does not depend on the user\'s answer.\n',
    after: 'carry on with whatever does not depend on the user\'s answer.\n- A started task is owed until it reaches its end state: committed, landed (merged in a hobby project, pushed to its PR in a work project), review comments answered and their threads resolved, records reconciled. When only an outside wait is left (a review bot, a build, a lane), end the turn only while something will wake you when it is over: a running lane, or the wait running as a background Bash. A detached process sends no notice when it ends or dies, so a wait left to one is parked work. If a turn must end with nothing to wake you, say plainly what is awaited and where it will show (GitHub issue #79, 2026-10-12: in a work-mode project a Copilot review sat unanswered for about 45 minutes after a detached wait died silently, and turns ended with fixes uncommitted or review threads open until the user asked again).\n',
  },
  {
    commit: 'GitHub #87',
    date: '2026-10-13',
    reason: 'a dropped codex MCP server is recovered with the user running /mcp reconnect all and one retry before the Opus or Fable fallback, because Claude Code does not restart a dead stdio MCP server (GitHub issue #87; finding why-do-the-codex-mcp-tools-vanish-for-the-rest-of-a-claude-c)',
    before: 'handed the same body through the `review-brief` skill. A practice, not a hook',
    after: 'handed the same body through the `review-brief` skill. When a `codex` call returns "Connection closed", or Claude Code lists codex as failed to connect, the server has died, and Claude Code does not restart a dead stdio MCP server by itself: its tools stay gone for the rest of the session. Ask the user to run `/mcp reconnect all` (an interactive slash command, theirs to run), retry the call once, and only if it still fails fall back (Opus for review, Fable for sparring) and say so (GitHub issue #87; finding `why-do-the-codex-mcp-tools-vanish-for-the-rest-of-a-claude-c`). A practice, not a hook',
  },
  {
    commit: 'GitHub #87',
    date: '2026-10-13',
    reason: 'the Astra sparring lane counts a dropped codex server as unavailable only after the reconnect-and-retry step (GitHub issue #87)',
    before: 'With neither available, say so and proceed. Agree',
    after: 'With neither available, say so and proceed. A dropped `codex` server counts as unavailable only after the reconnect-and-retry step in the Sol review paragraph above. Agree',
  },
  {
    commit: 'GitHub #90',
    date: '2026-10-14',
    reason: 'every codex call passes features.view_image=false, because an image result can push one MCP message past Claude Code\'s 16 MB stdio limit and Claude Code then drops the server for the rest of the session (GitHub issue #90; measured on codex-cli 0.153.4: tools.view_image does not remove the tool)',
    before: '(GitHub issue #87; finding `why-do-the-codex-mcp-tools-vanish-for-the-rest-of-a-claude-c`). A practice, not a hook',
    after: '(GitHub issues #87 and #90; finding `why-do-the-codex-mcp-tools-vanish-for-the-rest-of-a-claude-c`). Every `codex` call also passes `config: {features: {view_image: false}}`, because an image result can push one MCP message past Claude Code\'s 16 MB stdio limit, and Claude Code then drops the server for the rest of the session (GitHub issue #90); `tools.view_image` does not remove the tool on 0.153.4. A practice, not a hook',
  },
  {
    commit: '599e946b',
    date: '2026-10-15',
    reason: 'a clean Copilot review loop with the auto-merge switch on ends in a squash-merge of the work-mode PR, so the hobby-merge bullet no longer says a human always merges (decision work-mode-pr-auto-merge-when-copilot-loop-ends-clean)',
    before: 'Work mode is unchanged: a human merges the PR.',
    after: 'In a WORK project, /sterling:merge opens the PR; when the Copilot review loop ends clean and the auto-merge switch is on (the default), you squash-merge it as the `pr-review-loop` skill says, and otherwise a human merges it (decision `work-mode-pr-auto-merge-when-copilot-loop-ends-clean`).',
  },
  {
    commit: '599e946b',
    date: '2026-10-15',
    reason: 'the context-pressure paragraph says a work-mode PR is merged only at the end of a clean review loop with the auto-merge switch on (decision work-mode-pr-auto-merge-when-copilot-loop-ends-clean)',
    before: "with the PR's status reported — never merged; a human merges the PR.",
    after: "with the PR's status reported. The PR is merged only at the end of a clean review loop with the auto-merge switch on (the `pr-review-loop` skill); otherwise a human merges it.",
  },
  {
    commit: 'board 5ff6acd8',
    date: '2026-10-15',
    reason: 'an ask meant for another project goes onto that project\'s board through board_add with target_project, and this board keeps the tracker (decision hand-a-board-task-to-a-sibling-project-board-add-target-proj; user-ruled 2026-10-15)',
    before: 'A question answered only in chat is not boarded. The todo list stays',
    after: 'A question answered only in chat is not boarded. An ask meant for another project on this machine goes onto that project\'s board through `board_add` with `target_project` (its registry name), not onto this one; this board keeps the tracker, which shows when the other project has finished it (decision `hand-a-board-task-to-a-sibling-project-board-add-target-proj`). The todo list stays',
  },
  {
    commit: 'board a2e06183',
    date: '2026-10-15',
    reason: 'hand-off guidance for the receiver states, milestone and evidence: the sender names a milestone, the receiver marks a stuck task needs: user with needs_reason and closes with evidence (decision handoff-needs-user-blocked-milestone-evidence-pull-only-skew-safe; user-ruled 2026-10-15)',
    before: 'which shows when the other project has finished it (decision `hand-a-board-task-to-a-sibling-project-board-add-target-proj`). The todo list stays',
    after: "which shows when the other project has finished it (decision `hand-a-board-task-to-a-sibling-project-board-add-target-proj`). When a later task here depends on the other project's work, name the point it must reach with `milestone` (for example `merged` or `deployed:test`); its tracker then reads `unverified` if the work is closed without evidence. A task handed TO this project arrives with the sender's words: when it is stuck on the user, set `needs: user` with `needs_reason` saying what must be decided, so the sender's tracker shows it; close it with `board_remove` and a `note`, plus `evidence` (`commit`, `pr`, `deploy` or `url`) whenever the item names a milestone (decision `handoff-needs-user-blocked-milestone-evidence-pull-only-skew-safe`). The todo list stays",
  },
  {
    commit: 'work-mode-3-to-5-parallel-sol-reviewers',
    date: '2026-10-17',
    reason: "work mode runs 3 to 5 parallel Sol reviewers, so the one-reviewer sentence names the work-mode exception (decision work-mode-3-to-5-parallel-sol-reviewers-before-copilot-loop; user-stated 2026-10-17)",
    before: "dispatch **one** reviewer over the **riskiest part** of the whole branch's diff (runtime code under `packages/`, hooks, config, permissions, credentials, migration), never every file.",
    after: "dispatch **one** reviewer (work mode: 3 to 5 in parallel, see \"Work mode\" below) over the **riskiest part** of the whole branch's diff (runtime code under `packages/`, hooks, config, permissions, credentials, migration), never every file.",
  },
  {
    commit: 'work-mode-3-to-5-parallel-sol-reviewers',
    date: '2026-10-17',
    reason: "the one-review, one-fix-round, one-re-check cap is scoped to hobby mode; work mode has its own shape (same decision)",
    before: "Cap the loop at **one review, one fix round, one re-check by the same warm reviewer**; what is left at MEDIUM or below becomes recorded residual risk.",
    after: "In hobby mode cap the loop at **one review, one fix round, one re-check by the same warm reviewer**; what is left at MEDIUM or below becomes recorded residual risk. Work mode has its own shape below.",
  },
  {
    commit: 'work-mode-3-to-5-parallel-sol-reviewers',
    date: '2026-10-17',
    reason: "the Work mode paragraph: 3 to 5 parallel Sol reviewers over the whole branch before the PR, same rubric, count by risk, merge, one fix round, one warm re-check; supersedes the count of the 2026-09-29 one-Sol ruling (same decision)",
    before: "When the task is done, Sol reviews the whole branch ONCE, then the PR is opened and goes through the Copilot review loop on GitHub (user-ruled 2026-09-29 through the question form, \"One Sol at task end\" over \"Copilot only\": *\"It isnt needed to have sol review every loop. Just review when we are done with the task and make a PR\"*, because Copilot already reviews the PR, so a Sol pass per commit is duplicate review). Sol-before-PR takes precedence over the Terra\u2192Opus pairing above: in work mode Sol is the one mandatory pre-PR review, Terra-executed work included, so there are never two.",
    after: "When the task is done and before the PR opens, run **3 to 5 Sol reviewers in parallel**, then open the PR and run the Copilot review loop on GitHub. Decision `work-mode-3-to-5-parallel-sol-reviewers-before-copilot-loop` (user-stated 2026-10-17, verbatim: *\"For Work project I want to use more than just 1 cross vendor reviewer before the Copilot loop starts. I want 3-5 reivewers in parallel to run on a work project before the copilot loop starts\"*, because hobby projects accept the risk of one review while a work project has the Copilot loop after it and warrants more eyes first), settled through the question form as 'Same rubric, all Sol', 'Scale by risk, 3-5' and 'Merge, fix, one re-check'. This supersedes the count in the 2026-09-29 ruling \"One Sol at task end\" over \"Copilot only\" (*\"It isnt needed to have sol review every loop. Just review when we are done with the task and make a PR\"*, because Copilot already reviews the PR, so a Sol pass per commit is duplicate review); that ruling still stands for never reviewing per commit or per loop round.\n- **Same rubric, all Sol, whole branch.** Every reviewer gets the one rubric in the `reviewer` agent's body and the same brief over the whole branch's diff, and each runs on the Sol route named in the pairing paragraph above. Do not split them by angle and do not mix models. Start them all in the background in one message.\n- **Count by risk.** 3 for a small or low-risk diff; up to 5 when the diff touches runtime code, permissions, credentials or migrations. This is your judgement, not a setting.\n- **Merge, fix once, re-check once.** Merge and de-duplicate the findings, adjudicate each on evidence, run one fix round, then have one warm Sol reviewer re-check the fixes (the fix a review causes is not covered by that review). Findings left at MEDIUM or below become recorded residual risk. Then open the PR.\n\nSol-before-PR takes precedence over the Terra\u2192Opus pairing above: in work mode the Sol reviewers are the mandatory pre-PR review, Terra-executed work included, so there is no separate Opus review.",
  },
  {
    commit: 'work-mode-3-to-5-parallel-sol-reviewers',
    date: '2026-10-17',
    reason: "the Copilot-loop sentence says the Sol reviewers, not one Sol review, stay before the PR (same decision)",
    before: "and the one Sol review stays where it is, before the PR is opened.",
    after: "and the Sol reviewers stay where they are, before the PR is opened.",
  },
  {
    commit: 'implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause',
    date: '2026-10-20',
    reason: "the implementor tier rule narrows: Opus only for a new mechanism or store schema, a fail-closed decision changed across several sites, an unknown root cause, or after a Sonnet fix round; a single-area safety fix stays on Sonnet; the old trigger 'fail-closed or safety logic' fit nearly every lane (22 of 50 lanes on Opus, finding how-often-do-implementor-lanes-run-on-opus-vs-sonnet-and-why); the dead citation subagent-defaults-sonnet-5-5-opus-5-5-as-pin is replaced (user-ruled 2026-10-20)",
    before: "(Sonnet 5.5 by default; pin **Opus 5.5** on a dispatch when a Sonnet lane would likely need a second pass: a cross-cutting change applying one rule across many sites, open design choices in the brief, fail-closed or safety logic (parsers, permissions, locks, concurrency, migrations, store schema), debugging an unknown root cause, or a lane that already needed a fix round on Sonnet; name the reason in the brief. Everything well-scoped stays on Sonnet — decision `subagent-defaults-sonnet-5-5-opus-5-5-as-pin`) — the default",
    after: "(Sonnet 5.5 by default; pin **Opus 5.5** only when the lane designs a new mechanism or store schema, changes a fail-closed decision itself across several sites, debugs an unknown root cause, or follows a Sonnet lane that already needed a fix round. A single-area fix inside safety code (a hook, a permission rule, store code) stays on Sonnet: touching safety code is not by itself a reason. Open every implementor brief with a `Tier reason:` line naming the model and why, so the split can be re-measured — decision `implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause`, user-ruled 2026-10-20) — the default",
  },
  {
    commit: 'implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause',
    date: '2026-10-20',
    reason: "the brief-contents list gains the implementor's Tier reason line (same decision)",
    before: "**Return** (the exact shape you want). **Territory**",
    after: "**Return** (the exact shape you want); an implementor brief also opens with its `Tier reason:` line. **Territory**",
  },
  {
    commit: 'claude-code-sol-route-defaults-to-gpt-6-1-sol-with-loud-fallback',
    date: '2026-10-20',
    reason: "the Claude Code Sol pairing names gpt-6.1-sol, matching the OpenCode route, because the ChatGPT-account refusal depends on account, plan and sign-in, so one pinned id is not safe (GitHub issue #165, user-ruled 2026-10-20)",
    before: "Codex **Sol** (`gpt-5.6-sol`, dispatched through the `codex` MCP tool at `sandbox: read-only`)",
    after: "Codex **Sol** (`gpt-6.1-sol`, dispatched through the `codex` MCP tool at `sandbox: read-only`)",
  },
  {
    commit: 'claude-code-sol-route-defaults-to-gpt-6-1-sol-with-loud-fallback',
    date: '2026-10-20',
    reason: "the loud fallback: on the ChatGPT-account 400, say so, retry once on gpt-5.6-sol, then review on Opus and tell the user to check the Codex login; never silent (same decision)",
    before: "through the `review-brief` skill. When a `codex` call returns \"Connection closed\"",
    after: "through the `review-brief` skill. When Codex answers HTTP 400 \"not supported when using Codex with a ChatGPT account\", say so, retry once with `model: gpt-5.6-sol`, and if that is refused too, review on Opus and tell the user to check the Codex login (API key versus ChatGPT plan); never fall back silently (decision `claude-code-sol-route-defaults-to-gpt-6-1-sol-with-loud-fallback`, user-ruled 2026-10-20 on GitHub issue #165, because the refusal depends on account, plan and sign-in, so no single Sol id is safe). When a `codex` call returns \"Connection closed\"",
  },
  {
    commit: 'claude-code-sol-route-uses-gpt-5-6-sol-because-mcp-route-is-frozen-at-0-153-4',
    date: '2026-10-20',
    reason: "GitHub issue #169 reverses the #165 ruling: the Claude Code Sol pairing names gpt-5.6-sol again, because the Codex MCP route is frozen at client 0.153.4 and cannot reach gpt-6.1-sol (user-ruled 2026-10-20)",
    before: "Codex **Sol** (`gpt-6.1-sol`, dispatched through the `codex` MCP tool at `sandbox: read-only`)",
    after: "Codex **Sol** (`gpt-5.6-sol`, dispatched through the `codex` MCP tool at `sandbox: read-only`)",
  },
  {
    commit: 'claude-code-sol-route-uses-gpt-5-6-sol-because-mcp-route-is-frozen-at-0-153-4',
    date: '2026-10-20',
    reason: "the loud fallback loses its gpt-5.6-sol retry: on the ChatGPT-account refusal say so, review on Opus, tell the user to check the Codex login; never silent (same decision)",
    before: "When Codex answers HTTP 400 \"not supported when using Codex with a ChatGPT account\", say so, retry once with `model: gpt-5.6-sol`, and if that is refused too, review on Opus and tell the user to check the Codex login (API key versus ChatGPT plan); never fall back silently (decision `claude-code-sol-route-defaults-to-gpt-6-1-sol-with-loud-fallback`, user-ruled 2026-10-20 on GitHub issue #165, because the refusal depends on account, plan and sign-in, so no single Sol id is safe).",
    after: "When Codex answers HTTP 400 \"not supported when using Codex with a ChatGPT account\", say so, review on Opus, and tell the user to check the Codex login (API key versus ChatGPT plan; a lapsed or free account was the earlier cause); do not retry on another Sol id, and never fall back silently (decision `claude-code-sol-route-uses-gpt-5-6-sol-because-mcp-route-is-frozen-at-0-153-4`, user-ruled 2026-10-20 on GitHub issue #169, because the Codex MCP route is frozen at client 0.153.4, which cannot reach `gpt-6.1-sol`).",
  },
  {
    commit: 'board-needs-external-waits-on-outside-party-and-board-query-exposes-readiness',
    date: '2026-10-20',
    reason: "needs gains external, waiting on an outside party with a required needs_reason, rechecked when evidence arrives and never cleared because time passed; H1 prints a fourth group, WAITING ON OTHERS (GitHub issue #175, user-ruled 2026-10-20)",
    before: "`user` and `grill` wait for the user; absent means nothing. Set `needs` at intake when an item cannot start on its own, and clear it (`needs: \"\"`) once the user has answered. H1 prints three groups at session start and after a clear (READY, READY FOR RESEARCH, WAITING ON YOU)",
    after: "`user` and `grill` wait for the user; `external` waits on an outside party (a mail reply, a meeting, a branch someone else owns) and needs a `needs_reason` saying what is awaited and what lets the work resume; recheck it when that evidence arrives, never clear it because time passed; absent means nothing. Set `needs` at intake when an item cannot start on its own, and clear it (`needs: \"\"`) once the user has answered. H1 prints four groups at session start and after a clear (READY, READY FOR RESEARCH, WAITING ON YOU, WAITING ON OTHERS)",
  },
  {
    commit: 'sterling/sparring',
    date: '2026-10-22',
    reason: "sparring lanes run as the new `sparring` agent, not as `reviewer` (user-ruled, \"Yes, as stated\")",
    before: "Review, re-check and sparring lanes run as `reviewer` with the reviewer's model pinned",
    after: "Review and re-check lanes run as `reviewer` with the reviewer's model pinned",
  },
  {
    commit: 'sterling/sparring',
    date: '2026-10-22',
    reason: "the roster gains the read-only `sparring` agent, a bullet after the reviewer's (user-ruled, \"Yes, as stated\")",
    before: "The Codex Sol review loads the same body through the `review-brief` skill. Returns ranked findings, a test-integrity verdict per changed test file, the areas checked with nothing found, and a verdict.\n",
    after: "The Codex Sol review loads the same body through the `review-brief` skill. Returns ranked findings, a test-integrity verdict per changed test file, the areas checked with nothing found, and a verdict.\n- **sparring** — read-only by tool grant, the same grant as the reviewer (no Edit, Write or store-write tool). Its body is the sparring brief, not the review rubric: it takes your problem, your proposal and your objections, attacks the weak points, says where it disagrees and why, offers an alternative, and stays advisory, never gating. A sparring lane runs as `sparring`, never as `reviewer` or `general-purpose`, with the model pinned (the Fable fallback below; Astra goes through the `codex` MCP tool on this host). Returns the strongest objection, the points of disagreement with evidence, an alternative, what the proposal gets right and a recommendation.\n",
  },
  {
    commit: 'sterling/sparring',
    date: '2026-10-22',
    reason: "the Fable sparring fallback runs as the `sparring` agent, not as a Plan agent (user-ruled, \"Yes, as stated\")",
    before: "a `Plan` agent with `model: \"fable\"` pinned at the call (user-ruled 2026-10-01 through the question form, 'Fallback only').",
    after: "the `sparring` agent with `model: \"fable\"` pinned at the call (user-ruled 2026-10-01 through the question form, 'Fallback only'; the `sparring` agent replaced the `Plan` agent as the carrier on 2026-10-22).",
  },
  {
    commit: 'sterling/implementor-hard',
    date: '2026-10-23',
    reason: 'the hard implementor lane is its own agent, implementor-hard, so its brief opens with the Tier reason line too (decision hard-implementor-is-its-own-agent-sterling-implementor-hard)',
    before: 'an implementor brief also opens with its `Tier reason:` line.',
    after: 'an implementor or implementor-hard brief also opens with its `Tier reason:` line.',
  },
  {
    commit: 'sterling/implementor-hard',
    date: '2026-10-23',
    reason: 'where the implementor rule said pin Opus, the conductor dispatches implementor-hard (decision hard-implementor-is-its-own-agent-sterling-implementor-hard)',
    before: '- **implementor** (Sonnet 5.5 by default; pin **Opus 5.5** only when the lane designs',
    after: '- **implementor** (Sonnet 5.5 by default; dispatch **implementor-hard** instead, the same contract as its own agent on Opus 5.5 by default (decision `hard-implementor-is-its-own-agent-sterling-implementor-hard`), only when the lane designs',
  },
  {
    commit: 'sterling/implementor-hard',
    date: '2026-10-23',
    reason: 'the Tier reason line names implementor or implementor-hard and why, instead of a model (decision hard-implementor-is-its-own-agent-sterling-implementor-hard)',
    before: 'stays on Sonnet: touching safety code is not by itself a reason. Open every implementor brief with a `Tier reason:` line naming the model and why,',
    after: 'stays on the implementor: touching safety code is not by itself a reason. Open every implementor and implementor-hard brief with a `Tier reason:` line naming which of the two and why,',
  },
  {
    commit: 'sterling/preflight',
    date: '2026-10-23',
    reason: 'new roster bullet for the read-only preflight agent and when to dispatch it (decision knowledge-pre-flight-agent-sterling-preflight-a-read-only-la)',
    before: 'Each ends with `ESCALATE:` naming what it could not settle, or `none`.',
    after: 'Each ends with `ESCALATE:` naming what it could not settle, or `none`.\n- **preflight** — read-only knowledge pre-flight, with no edit, shell or store-write grant (decision `knowledge-pre-flight-agent-sterling-preflight-a-read-only-la`). Dispatch it before a design settles, before a question goes to the user, and before a fan-out, to check the premise the lanes share; not before every lane, since lanes are already staged by H22 and H20, and no hook fires it. The brief carries the proposed action, its alternatives or the question\'s options, and the paths. It runs the store\'s pre-write check in the store\'s vocabulary, opens every match, and returns a first line of `complete` or `blocked`, then a verdict (`governed`, `ungoverned`, `contradictory` or `inconclusive`), the binding records as `slug (id8)` with verbatim extracts, prior answers and coverage gaps, and ends with `ESCALATE:`. Its digest is a lookup, never the source: you still open the binding records yourself before a consequential choice, and `inconclusive` means search again, not that nothing governs.',
  },
  {
    commit: 'sterling/regrill-rule',
    date: '2026-10-24',
    reason: "new paragraph after the intake-grill paragraph: grill again when a finding changes an ask's premise (decision grill-again-when-a-finding-changes-an-ask-s-premise-restate; user-ruled 2026-10-24, \"Add it (Recommended)\")",
    before: 'you name that choice before starting it (decision `sterling-grill-skill-design`).\n',
    after: "you name that choice before starting it (decision `sterling-grill-skill-design`).\n\nGrill again when a finding changes an ask's premise. When research shows the ask cannot be met as the user framed it (the thing is 'by design', the fix 'we have' does not exist, the place to change is elsewhere), the next question restates the user's goal in their words and asks whether it still stands, before any option built on the finding. Every option list leads with a way to keep the user's goal. Before recommending any artifact as a fix, state in the question what changes at runtime once it merges; if the answer is 'nothing', say so. (User-raised 2026-10-24, after a docs-only Overpass PR was offered as the fix and the user's goal that their own effort wins was never asked; decision `grill-again-when-a-finding-changes-an-ask-s-premise-restate`.)\n",
  },
  {
    commit: 'sterling/not-a-reason-for-hard',
    date: '2026-10-25',
    reason: 'the implementor-hard criteria also say what is not a reason (decision implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause, amended to version 2; user-ruled 2026-10-25, "Add explicit exclusions")',
    before: 'touching safety code is not by itself a reason. Open every implementor and implementor-hard brief with a `Tier reason:` line naming which of the two and why, so the split can be re-measured — decision `implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause`, user-ruled 2026-10-20)',
    after: 'touching safety code is not by itself a reason. Not a reason for implementor-hard: a probe with no change to make, a single-site safety fix, or speculation about what the work might need (such as "likely a migration"). Building an already-ruled design and resuming a hard lane may stay on hard. Open every implementor and implementor-hard brief with a `Tier reason:` line naming which of the two and why, so the split can be re-measured — decision `implementor-defaults-to-sonnet-opus-only-for-mechanism-design-or-unknown-cause`, user-ruled 2026-10-20, exclusions added 2026-10-25 because the misses measured in the Customer Hub projects were probes, a single-site safety refusal and speculation, finding `how-often-do-conductors-use-implementor-hard-versus-implemen`)',
  },
  {
    commit: 'board background-shells',
    date: '2026-10-25',
    reason: 'a shell expected to take more than about 20 seconds runs in the background and the conductor never waits with a foreground sleep or poll (user-stated 2026-10-25; finding why-do-customer-hub-ch-conductors-sit-waiting-while-shells-r)',
    before: 'turns ended with fixes uncommitted or review threads open until the user asked again).\n',
    after: 'turns ended with fixes uncommitted or review threads open until the user asked again).\n- Run any shell command expected to take more than about 20 seconds (a test suite, a build, a deploy, a review wait, a setup chain) as a background shell (`background: true` on OpenCode, `run_in_background` on Claude Code); never wait in the foreground with `sleep`, `sleep N; tail …` or a polling loop. While it runs, report, dispatch or prep other work, and act when its completion notice arrives (AGENTS.md rule "Start every subagent and every long shell command in the background"; finding `why-do-customer-hub-ch-conductors-sit-waiting-while-shells-r`: Customer Hub conductors ran 29 foreground shells over 60 s and 110 foreground `sleep`/`tail` polls in five days).\n',
  },
  {
    commit: 'board 0961aa29',
    date: '2026-10-27',
    reason: 'while lanes run and one is free, read-only researcher lanes prepare the next not-yet-startable board items and return per-item briefs (user-ruled 2026-10-27 through the question form, GitHub #214)',
    before: 'ready-items-for-auto-start`). Serializing',
    after: 'ready-items-for-auto-start`). While lanes run and a lane is still free, prepare the next items that cannot start yet (blocked, or `needs` of `user` or `grill`) in parallel: send one read-only researcher lane per item or small group, which edits nothing and writes nothing to the store, so it adds no writer and counts against the same ceiling. Each returns a brief per item (the ask, the governing records by slug and id8, the files, the questions for the user, whether it is ready) and may propose a queue order; you decide the order, which stays unblock-first (decision `slice-ordering-is-unblock-first-pick-the-slice-that-most-wid`), and put the user\'s questions through the question form early, so their answers are in before the item\'s turn (user-ruled 2026-10-27 through the question form, GitHub #214). Serializing',
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
    reason: 'new rubric item 3: stop at the first that holds before writing new code (not needed, repo helper, standard library, installed dependency); never add a dependency for a few lines; never shortens the tests or the report (user-ruled, board efd77feb, the former finding implementor rubric: stop at the first that holds (not in the current store))',
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
  {
    commit: 'board b43ddc10',
    date: '2026-10-05',
    reason: 'the background-job rule names the project\'s own check command; `npm run check` is only what that is in a Node project with the script, because the template installs into projects of any stack (user-ruled, "Project lint and check commands")',
    before: 'never start the full suite or `npm run check` as a background job',
    after: 'never start the full suite or the project\'s check command (`npm run check` in a Node project that has that script) as a background job',
  },
  {
    commit: 'board 33489711',
    date: '2026-10-06',
    reason: 'a design choice the brief states as settled is a claim, not a ruling: the implementor runs knowledge_preflight on it and reports a contradicting record as a blocker (GitHub issue #29; user-ruled, "Implementor and reviewer check"); Sterling-only, so the portable render is unchanged',
    before: 'goes back to the conductor as an open question in your report; never ask the user yourself and never pick a default for a gate.\n',
    after: 'goes back to the conductor as an open question in your report; never ask the user yourself and never pick a default for a gate.\n\nA design choice your brief states as settled (a form, placement, colour, name, structure) is a claim, not a ruling: run `knowledge_preflight` on it in the file\'s own terms before building it. A standing record that contradicts the brief is a blocker you report, not something you build.\n',
  },
  {
    commit: 'issue #110',
    date: '2026-10-16',
    reason: 'new MCP tool knowledge_move (decision move-a-record-between-domains-with-knowledge-move-same-id) is denied to the implementor under both prefixes; store writes stay the conductor\'s',
    before: 'mcp__plugin_sterling_sterling__knowledge_promote, mcp__sterling__knowledge_link',
    after: 'mcp__plugin_sterling_sterling__knowledge_promote, mcp__sterling__knowledge_move, mcp__plugin_sterling_sterling__knowledge_move, mcp__sterling__knowledge_link',
  },
  {
    commit: 'e55db816',
    date: '2026-10-25',
    reason: 'new MCP tools board_claim, board_reaffirm, board_release and board_takeover (decision board-task-claims-for-parallel-sessions-claim-generation-ren) are denied to the implementor under both prefixes; claim writes are store writes and stay the conductor\'s, like board_update',
    before: 'mcp__plugin_sterling_sterling__board_edit, mcp__sterling__maintenance_remove',
    after: 'mcp__plugin_sterling_sterling__board_edit, mcp__sterling__board_claim, mcp__plugin_sterling_sterling__board_claim, mcp__sterling__board_reaffirm, mcp__plugin_sterling_sterling__board_reaffirm, mcp__sterling__board_release, mcp__plugin_sterling_sterling__board_release, mcp__sterling__board_takeover, mcp__plugin_sterling_sterling__board_takeover, mcp__sterling__maintenance_remove',
  },
  {
    commit: 'board 05fbab98',
    date: '2026-10-25',
    reason: 'new MCP tool board_adopt (claims hand over across /new, decision board-task-claims-for-parallel-sessions-claim-generation-ren) is denied to the implementor under both prefixes; claim writes are store writes and stay the conductor\'s',
    before: 'mcp__plugin_sterling_sterling__board_takeover, mcp__sterling__maintenance_remove',
    after: 'mcp__plugin_sterling_sterling__board_takeover, mcp__sterling__board_adopt, mcp__plugin_sterling_sterling__board_adopt, mcp__sterling__maintenance_remove',
  },
];

export const LIBRARIAN_WORDING_EDITS = [
  {
    commit: 'issue #128',
    date: '2026-10-17',
    reason: 'the librarian applies conductor-drafted board edits, so it holds board_edit under both prefixes; without it a partial text edit had to go back to the conductor',
    before: 'mcp__plugin_sterling_sterling__board_update, mcp__sterling__board_remove',
    after: 'mcp__plugin_sterling_sterling__board_update, mcp__sterling__board_edit, mcp__plugin_sterling_sterling__board_edit, mcp__sterling__board_remove',
  },
  {
    commit: 'issue #128',
    date: '2026-10-17',
    reason: 'the body lists board_edit among the board mutations the librarian performs, matching its grant',
    before: '(`board_add`/`board_update`/`board_remove`, `maintenance_remove`)',
    after: '(`board_add`/`board_update`/`board_edit`/`board_remove`, `maintenance_remove`)',
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
export const applyLibrarianWordingEdits = (baselineText) => applyWordingEdits(LIBRARIAN_WORDING_EDITS, baselineText);
