# Sterling takeover 2026-09 — scale-down to the OpenSterling boundary

Projection of the board + decisions as of 2026-09-19; the store is the source of truth; regenerate at each slice boundary.

## Where this plan lives

Board objective: `sterling-takeover-2026-09` (`board_query objective:"sterling-takeover-2026-09"`). Governing decisions: `sterling-claude-code-scale-down-boundary` (2ad87dd1), `scale-down-enforcement-rules-and-locks-are-friction` (38c9e860), `review-sparsely-before-commit-ledger-kept` (276cd235). This file: `docs/STERLING-TAKEOVER-PLAN.md`.

## User rulings (verbatim)

- 2026-09-19: "All the rules and locks is friction, so I want to scale it down ALOT!" (decision `scale-down-enforcement-rules-and-locks-are-friction`)
- 2026-09-19: "You need to fix that you can change the config yourself." (same decision)
- 2026-09-19: "There is no more other engineers, from now on it is just us, so we dont need the cloud data base at all, everything can run locally" (decision `sterling-claude-code-scale-down-boundary`)
- 2026-09-19: "everything going forward should run through WSL2. change the bat files so they open the project in WSL2 instead of windows" (decision `sterling-claude-code-scale-down-boundary`; also quoted on board item slice-1)
- 2026-09-19: "everything can run locally" (board item slice-1)
- 2026-09-19: "we use sol for review" / "or opus if it was executed by terra" (decision `sterling-claude-code-scale-down-boundary`)
- 2026-09-19: "do add that AStra is also for solution sparring between fable and Astra" (decision `sterling-claude-code-scale-down-boundary`)
- 2026-09-19: "we dont review everything as that is overkill, we only review before a commit, and we still do it sparsely" (re-affirmed for Sterling 2026-09-19, first stated in OpenSterling 2026-09-18; decision `review-sparsely-before-commit-ledger-kept`)
- 2026-09-19: "THE MOST IMPORTANT THING IS THAT YOU DELEGATE. YOU USE YOUR BIG MODEL TO BRIEF DUMBER MODELS WITH HIGH QUALITY BRIEF, FOLLOWING THE PLAN, UPDATING THE PLAN, MAKING GOOD DECISIONS ON WHICH SUBAGENT TO GO NEXT" (board item slice-3, quoted in the conductor-contract work item)
- 2026-09-19 (rationale, decision `scale-down-enforcement-rules-and-locks-are-friction`): the deleted mechanisms bought certainty "200% secure instead of 99.9 at a heavy price"; read-before-edit "was just friction in the end"; the delegation nag was "symptom treatment and not rootcause fixes" (decision `sterling-claude-code-scale-down-boundary` rationale)
- 2026-09-19 (OpenCode comparison, decision `sterling-claude-code-scale-down-boundary` alternatives_rejected): OpenCode "was pure delegating and using fable as conductor made the briefs wildly strong"
- 2026-09-19 (board item slice-8): "move over what we agreed from opensterling project, agents, skills and whatever"

## Boundary: what stays, what goes

Boundary text (decision `sterling-claude-code-scale-down-boundary`): per `OpenSterling/docs/OPENSTERLING-PORT-PLAN.md` §2 — "The full staged pipeline, frozen-test/read-wall apparatus, shell-command policing, enforcement self-protection, review-receipt ledger, merge gates, and automatic large council are not part of the product."

### KEEP — 11 hook families + surfaces

H1 (slimmed to rotation note, queue depth, board counts), H2 (selection), H7 (touch register), H10 (capture/reconcile duties and its context-pressure gauge), H16 (event register), the H19 delivery family, H20 and H23 (as advisories — H20's AskUserQuestion deny removed), H15 (reduced to one rule — nothing but the MCP server writes `sterling.db`; every other `.sterling/` file is editable by any tool), H22 (minimal dispatch bookkeeping for child-agent knowledge staging), H31 (plan lock). Plus: knowledge tools, board, TUI, and the debug/drain/cleanup SOPs.

### DELETE — 17 hook families + apparatus

H3, H4, H5, H6, H8, H9, H13, H14, H17, H18, H21, H24, H25, H26, H27, H29 (keeps its failure-observation purpose as a small non-blocking check), H30. Plus: the staged pipeline (brain, run_signal/run_state/run_escalate, dispose-run, phases, skills feature/grill-intent/grill-plan/planning); commit-reviewed, review-ledger and the Reviewed-By-Agent trailer refusal; the `/sterling:merge` gate's refusals; enforcement self-protection (sanctioned-script provenance, enforcement baselines, `enforcement_reconcile`); `config_set`'s key allowlist; the council skill.

### Three harness-specific changes to the port plan

1. The context-pressure gauge stays, measured against the correct window (`claude-fable-5-1` = 1,000,000 — research finding `why-did-sterling-s-h10-context-pressure-warnings-escalate-to` (057f39d6) documents the earlier 98.6%-over-a-200k-default incident this fixes).
2. Touches are registered from git, not tool calls — at Stop, H10 reads `git diff --name-only` against the last settled commit so hand, shell and agent edits mint the same reconcile duties (replaces what H17 protected for the knowledge loop).
3. The roster takes OpenSterling's shape — implementor, researcher, scout, librarian on Claude; reviews go to the OTHER model family than the executor: Codex Sol reviews Claude-executed work, Claude Opus reviews Terra-executed work; Terra (gpt-5.6-terra) is an implementation-class model, Sol is gpt-5.6-sol, Astra is gpt-6-astra; Astra is the solution-sparring partner between Fable (conductor) and Astra before a non-trivial design settles. `coder`, `test-writer`, `implementation-architect`, `debugger`-as-a-class and the four roster reviewers are deleted.

Tests: tests-first stays a contract line in the implementor's role ("you own the change and its tests"), never a hook.

### Roster shape and review pairing

implementor (sonnet — owns the change AND its tests, "never ship weakened tests"), researcher (sonnet — read-only tracing, capture candidates only), scout (sonnet — decision `55b5b611`: 50 runs each, sonnet beat haiku by miles; compact conclusion + path:line map + a few exact excerpts + explicit coverage gaps, files examined N of M, an `ESCALATE:` line — NOT blanket verbatim excerpts, per Astra), librarian (update-only store maintenance, unchanged grant); Terra as an implementation-class model when chosen. Deleted: coder, test-writer, implementation-architect, debugger-as-a-class, reviewer-correctness/-performance/-security/-skeptic; strips the frontmatter hooks (H4/H5/H14/H17/H18, and h6-context-watch which is in all 11 templates) they carry; drops `PIPELINE_AGENT_TYPES`/class marking (decision `87f5f982`) and its `AGENT_CLASS` mirror in `packages/schemas/src/records.ts` plus the TUI readers, in the same commit (see `docs/drafts/slice-2-removal-map.md` §3).

Review pairing (user-ruled: "we use sol for review" / "or opus if it was executed by terra"): the reviewer is always the OTHER family — Codex Sol (gpt-5.6-sol) reviews Claude-executed work, Claude Opus reviews Terra-executed work; one review before a commit over the riskiest part of the diff PLUS every changed test in full; a review claim needs a substantive response on the FINAL diff. Astra (gpt-6-astra, reasoning high) is the solution-sparring partner between Fable and Astra before a non-trivial design settles, and on demand. Consults run via `codex exec` (see memory `codex-models-and-consults`) until the codex MCP is wired in WSL. No review ledger, no `commit-reviewed`, no merge-gate trailer refusal (decision `review-sparsely-before-commit-ledger-kept`, revised same day to drop the ledger it originally kept).

### Environment

Local SQLite only, no cloud PostgreSQL path. Claude Code, the Sterling clone, Codex and every project run under WSL2 (Ubuntu-24.04); the Windows `.bat` launchers open the project inside WSL2. `packages/store` already demotes a store opened over `/mnt/<drive>` to `journal_mode=DELETE` (`index.ts:971`), so project stores stay where they are.

### Sequencing

Cut first (deletion unblocks Dome Farmer); fix only the Dome Farmer defects that survive the cut; build no new knowledge-loop features in Sterling; converge on OpenSterling's knowledge core once its M5 exit holds rather than building the loop twice.

## Why: measured evidence

Research finding `conductor-context-split-dome-farmer-september-2026` (e6d57b70) — measured over ALL 51 Dome Farmer Claude Code September 2026 transcripts (151 files total, 0 parse failures). Population: conductor transcripts only, subagent contexts not measured.

| Category | Share of 60,962,866 chars (~15M tokens) |
|---|---|
| Tool results | 33.0% |
| Assistant output incl. tool_use JSON | 25.2% |
| Harness bookkeeping attachments (prompt snapshots, CLAUDE.md, skill listings, agent-listing deltas, reminders) | 22.8% |
| Hook-injected text | 10.5% (Sterling hook denials only 0.2% — negligible in chars, costly in retries) |
| User text | 8.6% |

13 active days, 3.9 sessions/active day (the "5 clears a day" is real). Largest single injections: H20 dispatch delivery 10,460 chars, H1 conventions 9,971, H19 bash pointers 9,951. Largest session 09-01: 3.99M chars (~1M tokens) over 22.5h, 695 tool calls — the full 1M window. Conclusion: Sterling's hooks were a real but minority contributor (~10% direct, plus the 71KB CLAUDE.md in the instructions bucket); the majority was the conductor's own hand-work (tool results + own output = 58%) — exactly the posture gap versus the OpenCode conductor ("you are the delegator, not the worker"), plus H10 demanding a clear at 50% of the window.

Decision `sterling-claude-code-scale-down-boundary` measured: 17 families and roughly 12,000 lines of hook code removed, including the four largest files (H17 4,851; H10 2,326; H1 2,059; H15 1,534 lines); fixed per-session injection falls from ~85KB toward ~25KB; the native-Windows defect class (H15 word syntax, `.cmd` spawning, `enforcement_reconcile` refusing on Windows) is removed entirely by WSL2.

Dome Farmer issue clusters named in the slice texts: I-16/I-18 (H26), I-19 (H25), I-37 (H30), I-41 (dispatch residue), I-07 (`enforcement_reconcile`), I-02..I-04/I-20/I-25/I-31/I-33/I-35/I-39 (H14/H15) — all die with their mechanism at the cut. Surviving defects are carried in Slice 7 below.

## Slices

### Slice 1 — WSL2 is the only runtime; this clone is the author machine

Evidence (board item `slice-1-make-this-clone-the-author-machine-sterling-config-j`, c6180ba0): "everything going forward should run through WSL2. change the bat files so they open the project in WSL2 instead of windows" and "everything can run locally".

DONE 2026-09-19: Claude Code 2.1.278 and Codex CLI 0.155.1 installed natively in WSL (Ubuntu-24.04, Node v24.21.0, tmux present, `~/.local/bin` on PATH); `init.mjs` fixed for the `header_repaired`/`machine_rebaked` sync statuses it crashed on (`scripts/init-impl.mjs:669-670`); init re-run from WSL for sterling-main and Dome Farmer — `sterling-launch.sh`, `sterling-update.bat`, `.claude-plugin/sterling-mcp.json` regenerated with `/mnt/c` + Linux node paths, installed agents rebaked for Linux, native `sterling-windows.bat` and `sterling-mcp-win.json` deleted; the store already demotes to `journal_mode=DELETE` on `/mnt/<drive>` (`packages/store/src/index.ts:971`), so project stores stay on `/mnt/c`.

REMAINING: (a) user logs in — `claude` and `codex login` inside WSL (both "not logged in" as of 2026-09-19); (b) domain stores — live ones are Windows-side `C:/Users/chulf/.sterling/domains` (blender, gdscript, godot, node, python, sterling, typescript), WSL-side `~/.sterling` was created fresh by init — copy or symlink before the first WSL session or domain knowledge is invisible; (c) Dome Farmer's Blender MCP in WSL — `uv` is missing in WSL and WSL networking is NAT, so the socket to the Windows Blender addon needs the host IP or mirrored networking; (d) `machine_role` → author, `context_watch.windows["claude-fable-5-1"]=1000000` once config.json is editable (Slice 2); (e) SpaceExplorer (`C:/Users/chulf/Comsoft`, last seen 2026-07-26) is dormant — user decides prune or re-init; (f) first real WSL session: `sterling.bat` → tmux split with claude + TUI, MCP server up, one `knowledge_query` works.

### Slice 2 — THE CUT

Evidence (board item `slice-2-the-cut-delete-17-hook-families-and-their-tests-lib`, eaa9dd5c): decision `sterling-claude-code-scale-down-boundary`. Scoping map: reference material `Slice 2 removal map` (7ef71ac6, `docs/drafts/slice-2-removal-map.md`) — explorer-produced: hooks.json lines to remove (12 live registrations, six families wired only through agent-template frontmatter), the lib helper split, pipeline tool registrations in `server.ts`/`tools.ts`, the `direct-merge.mjs` trailer block vs. the surviving merge+sweep, test files to delete/trim, config keys to delete/split, and ranked KEEP-side breakage risks (h10:186 / h16:17 run branches, h22-only ledger entries, H20's unlocated deny branch, AGENT_CLASS mirror + TUI); its §§6, 7 and parts of 4/8 are explicitly INCOMPLETE.

DONE 2026-09-19: H15 rebuilt from blank to the one-rule form and `config_set`'s key allowlist removed — committed as `226ba40` on branch `takeover/h15-one-rule-and-config-set` (Terra + Sol reviewed; Sol round 3 REQUEST_CHANGES on the shell arm — clobber/concatenated redirects and newline-separated fragments passed, recursive deletion of the `.sterling` directory passed, same-named files outside the store were denied). The shell-arm TOKENIZER rebuild against Sol's frozen cases is now DONE: 35 pins green, mutation-verified; Sol round-4 review pending.

REMAINING: delete 17 hook families and their tests/lib helpers/`hooks.json` registrations (H3, H4, H5, H6 context-watch+selfcheck, H8, H9, H13, H14, H17, H18, H21, H24, H25, H26, H27, H29 minus its keep, H30); delete the staged pipeline (brain/state machine, `run_signal`/`run_state`/`run_escalate`, `agent_exit`-as-phase-signal, `dispose-run`, `consume-exit`, phase prep, skills feature/grill-intent/grill-plan/planning/council); delete commit-reviewed, review-ledger, the `/sterling:merge` gate refusals (merge becomes a plain merge + sweep), enforcement self-protection; remove H20's AskUserQuestion deny (stays a pointer). Complete removal migration per Astra (see consult log below): H1 still imports the review ledger, H7/H10/H16 branch on active pipeline runs, installed agent frontmatter + hook bundles retain deleted restrictions, obsolete run state must be retired while unresolved duties survive. Frontmatter-declared hooks (H4/H5/H14/H17/H18) live in `agent-templates` — strip them there.

Acceptance: a working consumer session on the reduced install — ordinary shell commands succeed; config changes take effect; obsolete run state does not suppress capture; knowledge reaches a worker before action; surviving maintenance does not remint paid debt. Rebuild bundles and mcp-server; run remaining suites; regenerate `architecture.md`. Reconcile: every `feature_article` owning a deleted file gets `state:deprecated` with the reason, never hard-deleted. One Sol review before each commit. Evaluate replacing H15's structured arm with an `Edit(**/.sterling/sterling.db*)` permission deny rule (research finding `claude-code-permission-deny-rules-as-store-seal`, 02319125).

### Slice 3 — conductor context diet

Evidence (board item `slice-2-conductor-context-diet-measured-2026-09-19-claude-md`, d0f3647a): measured 2026-09-19 — CLAUDE.md 71,368 bytes auto-loads every session; H1's conventions block (~11KB) restates it; H19 delivers 13,010–17,078 bytes per governed article (`payload_char_cap:2400` per field, no per-delivery total); H20 injected ~3.5KB on one over-broad match; `board_query` headline/digest rows overflow the tool budget at 75–87KB (Dome Farmer I-24, I-40). Measured context split (research finding e6d57b70, see table above): tool results 33%, conductor output 25%, harness bookkeeping 23%, hooks 10.5% — the conductor's own hand-work is the majority.

DRAFTS IN FLIGHT 2026-09-19, opus-authored, with a dropped-rules list for the conductor to veto: `docs/drafts/CLAUDE.next.md` and `docs/drafts/conductor-contract.md`.

Work: (a) rebuild CLAUDE.md from blank as lean conventions (≤15KB) — P1-P8, authority/retrieval/reconcile rules, conduct rules that survive the cut, no incident narratives for deleted mechanisms; (b) write the conductor contract once (≤10KB), modelled on OpenSterling's `conductor.md`, injected by H1 instead of the conventions copy; it carries, verbatim where a rule rests on a ruling: THE CONDUCTOR DELEGATES AND DOES NOT DO THE WORK ITSELF (user: "THE MOST IMPORTANT THING IS THAT YOU DELEGATE..." — hand-work only for a ruling, a small authored record, verifying one claim with one command, and the commit; a classifier-denied dispatch means ask the user for a permission rule, never do it by hand); brief quality as the conductor's product (point at files/records, never paste); warm-agent reuse; one writer per file; the roster and review pairing from Slice 5; capture by the conductor from agents' capture candidates; the three surfaces never collapsed; the 50% context target as a warning to finish and commit (not a demand to clear); keep the plan (board + this file) updated at every slice boundary. (c) DELIVERY BEFORE ACTION (Astra, fatal finding): rung stays 'read'; H19 gets a per-delivery total cap and cross-entry dedup across the turn, hazards verbatim, the rest as pointers. (d) H20/H23 match floor raised so generic terms do not fire. (e) `board_query` rows text-only unless `projection:full`. (f) shorter MCP tool descriptions. (g) mirror to `templates/target-claude-md.md`. Done when a fresh session's fixed injection is under 30KB and one governed Read costs under 4KB.

### Slice 4 — touches from git, gauge with the right window

Evidence (board item `slice-4-touches-from-git-gauge-with-the-right-window-at-stop`, 400f578b): decision `sterling-claude-code-scale-down-boundary` changes 1 and 2.

NOT YET STARTED. (a) At Stop, H10 reads `git diff --name-only` (working tree + index) against the last settled commit and unions it with H7's tool-call touch register, so hand edits, agent shell edits and Edit-tool edits all mint the same `reconcile_needed`/capture duties (~20 lines); settlement in `lib/settlement.mjs` must treat the git set and the register set identically. (b) context-pressure gauge stays against `context_watch.windows[model]`; add `"claude-fable-5-1": 1000000` (research finding `why-did-sterling-s-h10-context-pressure-warnings-escalate-to`, 057f39d6); missing-entry case says the number is unreliable rather than reporting a percentage. Pins: a file edited only via Bash appears in the Stop duties; a file in the register but unchanged in git does not mint; Fable session reports fill against 1,000,000.

Astra follow-up folded in: diff against a PERSISTED settled SHA (not HEAD), include untracked files (`git status --porcelain`), never advance the baseline prematurely; H10's clear demand becomes a warning at the 50% target measuring occupied context (post-compaction), not cumulative transcript tokens; drop tool-activity capture nags, keep durable specific duties.

### Slice 5 — roster to OpenSterling's shape

Evidence (board item `slice-7-scout-class-with-a-structured-count-bearing-handoff`, b6fff187, text titled "Slice 5" in the item body): decision `sterling-claude-code-scale-down-boundary` change 3, decision `review-sparsely-before-commit-ledger-kept` as revised 2026-09-19.

NOT YET STARTED. Roster and review pairing as stated under "Roster shape and review pairing" above. Delete coder, test-writer, implementation-architect, debugger-as-a-class, reviewer-correctness/-performance/-security/-skeptic; strip the frontmatter hooks (H4/H5/H14/H17/H18, and h6-context-watch which is in all 11 templates) they carried; drop `PIPELINE_AGENT_TYPES`/class marking (decision `87f5f982`) and its `AGENT_CLASS` mirror in `packages/schemas/src/records.ts` plus the TUI readers in the same commit (see `docs/drafts/slice-2-removal-map.md` §3). Record model routing in config (`sparring_partner.model` etc.) and in the conductor contract (Slice 3). `install-agents` re-renders per-project `.claude/agents`; sync Dome Farmer.

Astra follow-up: scout contract = compact conclusion + path map + a few exact excerpts + explicit coverage gaps (NOT blanket verbatim excerpts); the pre-commit reviewer inspects ALL changed tests/fixtures/assertion removals in full; a review claim needs a substantive response on the FINAL diff.

### Slice 6 — /sterling:update reaches agent sync on consumers

Evidence (board item `slice-5-sterling-update-must-reach-agent-sync-on-consumer-ma`, 2b37272a, text titled "Slice 6" in the item body).

NOT YET STARTED. `/sterling:update` must reach agent sync on Dome Farmer/SpaceExplorer (now WSL2 consumers of this author clone). Dome Farmer blocked two days running (I-05 2026-09-08: 170/4337 failing, 14 failing names carry "expect RED today" in their own title; I-17: 171/4526, rerun then reports "Already current — nothing to do" without ever having synced). I-06: with `--no-test` the fan-out halts on a sibling project's store migration (Comsoft, "5 legacy supersession conflict(s)") before reaching Dome Farmer. Fix after the cut (many failing tests belong to deleted mechanisms): continue-on-sibling-failure with a per-project report; a halted run leaves a marker so "Already current" cannot be reported until sync completed; expected-RED tests removed with their mechanisms. No cloud/other-engineer path remains — update stays git fast-forward from origin Chulf58/sterling.

### Slice 7 — Dome Farmer defects that survive the cut

Evidence (board item `slice-6-maintenance-queue-mint-and-mcp-tool-defects-from-dom`, 5f633688, text titled "Slice 7" in the item body).

NOT YET STARTED. Re-verify each against HEAD after Slice 2; several die with their mechanism (I-16/I-18 H26, I-19 H25, I-37 H30, I-41 dispatch residue, I-07 `enforcement_reconcile`, I-02..I-04/I-20/I-25/I-31/I-33/I-35/I-39 H14/H15). Remaining: (a) `reconcile_needed` mints on ownership not on changed lines — one `main.gd` commit minted for every owning article, 61 of 71 already paid, ~620k subagent tokens (I-29); mint only when changed hunks fall inside the article's `files[]` role, or dedupe against `baseline_attestations`. (b) `knowledge_array_remove` on `links[]` reports removal and bumps version twice while the element stays (I-14); refuses dropping one directory `files[]` claim while a second exists (I-36); silently dropped a path a file_parked item said DO NOT DROP (I-38). (c) `knowledge_append` to history refused because `files[]` carries directory paths (I-26, 3x). (d) `maintenance_remove` cannot close an item whose owned file was deleted (I-13) or is untracked/gitignored (I-27); refuses already-paid closes on an uncommitted tree (I-32). (e) H10 re-demands capture every Stop while `capture_pending` is live (I-01). (f) `refresh_reference` items name no delta so no drain can close them (I-42). (g) librarian drain stops early on "effort budget" — `config.models.librarian` effort=low suspected (I-34). Small fixes, one commit per group, one Codex review before each commit.

Astra follow-up: an explicit maintenance execution policy — who starts the drain, bounded trigger, retry, visible backlog age; Stop events coalesce by article and source state; the mint storm is a release defect.

### Slice 8 — port what OpenSterling already settled: agents and skills

Evidence (board item `slice-8-port-what-opensterling-already-settled-agents-and-sk`, 1d81aec3, new 2026-09-19): user "move over what we agreed from opensterling project, agents, skills and whatever".

NOT YET STARTED. Source (read, do not copy blindly — Sterling's tool names differ): `OpenSterling/.opencode/agents/{conductor,baseline,implementor,researcher,scout,reviewer,reviewer-opus}.md` and `.opencode/skills/{orchestration/delegating-to-subagents, architecture/design-research, architecture/decision-records, development/closing-out-tasks}/SKILL.md`.

AGENTS → `agent-templates/`: `implementor.md` (owns change + tests, stays in scope, smallest correct change, pastes real command output, write grant = code/tests only, capture candidates back to the conductor); `researcher.md` (rewrite from OpenSterling's: read-only tracing of code/docs/git history, verified/inferred/unknown kept separate, "found no evidence in <surfaces>" phrasing, no store writes — replaces the current online-only researcher that `knowledge_create`s); `scout.md` (compact path:line map, coverage N of M, `ESCALATE:` line — replaces `explorer.md`); a reviewer contract as a BRIEF TEMPLATE for the Sol/Opus review (ACs first, then project rules, then correctness; severity CRITICAL/HIGH/MEDIUM/LOW; path:line; verdict); `librarian.md` unchanged. Tool grants use Sterling's `mcp__sterling__*` names (`knowledge_query`/`get`, `board_query`/`get`; no `knowledge_create` for any of them). The conductor posture goes to the H1-injected contract (Slice 3), modelled on `conductor.md`; `baseline.md`'s "right-size the ceremony" lines fold into it.

SKILLS → `skills/`: delegating-to-subagents (delegate-vs-do test, brief fields Objective/Context/Scope/Out of scope/Acceptance/Budget/Return, one writer per file, artifacts to disk, synthesize-don't-relay, 3-5 concurrent band as guidance not quota); design-research (search order: store sweep → repo docs → prior art via scout → platform docs → web; SOURCED/LOCAL/INFERENCE/RECOMMENDATION labels; reuse over build); decision-records (adapted to `knowledge_create`/`knowledge_update`/`knowledge_retire` and `knowledge_preflight` — Sterling has a preflight tool, OpenSterling does not); closing-out-tasks (evidence → cleanup sweep → capture, three surfaces never collapsed; adapted to `board_remove` and the maintenance queue). Keep debug/drain/cleanup. Register in `check-skills.mjs`/`check-agent-registry.mjs`; delete the pipeline skills in Slice 2.

Done when `install-agents` renders the four agents into a project and a fresh session lists the four skills.

## External-model consult log

**Astra round 1** (GPT-6-Astra, reasoning high, read-only over the repo, 2026-09-19) — positions recorded on decision `sterling-claude-code-scale-down-boundary` rationale, adjudicated by the conductor.

AGREED AND ADOPTED: (a) a merge gate is unnecessary but a reliable reconciliation trigger is needed — name who starts the drain, how interrupted work resumes, how backlog age is visible; (b) the pre-commit reviewer must inspect ALL changed tests, fixtures and assertion removals, not only the riskiest code; (c) git-based touch registration must diff against a PERSISTED settled SHA (not HEAD) and include untracked files; (d) H10's clear demand becomes a warning at the user's 50% target, measuring occupied context, compaction is a continuity event; (e) prompt-rung delivery is FATAL to the knowledge loop staying intact — it queues until next user submission and skips child-agent touches; delivery must land before action, small and deduplicated per turn, hazards verbatim (the rung was reverted from prompt to read the same day; the cap is Slice 3's first job); (f) cut first, acceptance = working consumer session as stated in Slice 2; (g) the removal must be a complete migration (H1 review-ledger import, H7/H10/H16 pipeline branches, agent frontmatter/bundles); (h) "scout returns verbatim excerpts" rejected as a blanket rule in favour of compact conclusion + path map + a few exact excerpts + explicit coverage gaps; (i) keep H29's failure-observation purpose as a small non-blocking check.

DISAGREED, CONDUCTOR'S CALL STANDS: Astra would delete H15's shell arm entirely and keep only the structured-destination guard; the conductor kept the shell arm (evaluated for replacement by a harness-native permission deny rule in Slice 2 — see research finding `claude-code-permission-deny-rules-as-store-seal`, 02319125, which found the shell arm cannot be expressed as pure policy data and must stay a hook).

Also noted by Astra: the OpenSterling port plan still specifies cloud support and excludes other harnesses — the user's 2026-09-19 rulings supersede that; the shared-core contract must be made explicit before convergence work.

**Terra/Sol reviews** (per Slice 2 progress and the H15 article history): Sol review round 3 on the H15 rebuild — REQUEST_CHANGES on the shell arm (clobber/concatenated redirects and newline-separated fragments passed the guard; recursive deletion of `.sterling` passed). Terra review — HIGH on the raw-text exemption (Sterling-script provenance could be laundered by a preceding fragment). Both closed 2026-09-19 by rebuilding the shell arm as open-world destructive-shape matching rather than patching the closed-world verb classifier. Shell-arm TOKENIZER rebuild against Sol's frozen cases now DONE (35 pins green, mutation-verified); Sol round-4 review pending.

## Open questions and user actions

- Three WSL actions outstanding (Slice 1 remaining a–b): `claude` login and `codex login` inside WSL; copy or symlink the Windows-side domain stores (`C:/Users/chulf/.sterling/domains`) into WSL before the first WSL session.
- SpaceExplorer (`C:/Users/chulf/Comsoft`, Sterling 0.1.0, last seen 2026-07-26) is dormant — user decides prune or re-init.
- Blender MCP in WSL for Dome Farmer needs `uv` installed in WSL and a networking fix (host IP or mirrored networking) for the socket to the Windows Blender addon to reach it.
- The shared-core contract between this clone and OpenSterling must be made explicit before convergence work (Astra's note) — OpenSterling's own plan still specifies cloud support and other-harness exclusion that the user's 2026-09-19 local-only/WSL2-only rulings now supersede for this side.
- The user will `/clear` after the next commit and continue in WSL2.
