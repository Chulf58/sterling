# Sterling takeover 2026-09 — scale-down to the OpenSterling boundary

Projection of the board + decisions as of the evening of 2026-09-19; the store is the source of truth; regenerate at each slice boundary.

## Where this plan lives

Board objective: `sterling-takeover-2026-09` (`board_query objective:"sterling-takeover-2026-09"`). Governing decisions: `2ad87dd1`, `38c9e860`, `276cd235`, and session posture `ff9937f3`. This file: `docs/STERLING-TAKEOVER-PLAN.md`.

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
- 2026-09-19: "Have Astra review and advice on everything regarding the knowledge delivery. It is the core of Sterling" (decision `knowledge-delivery-target-design-no-delayed-delivery`)
- 2026-09-19: user chose "Checkpoint, then scale down" for the open delivery findings (board `7b4d9f3a`)

## Boundary: what stays, what goes

### KEEP — 11 hook families + surfaces

H1, H2, H7, H10, H16, H19, H20, H23, H15, H22 and H31; knowledge tools, board, TUI, and debug/drain/cleanup SOPs. H20/H23 are advisory and H20 no longer denies AskUserQuestion. H15 is one rule: only the MCP server writes `sterling.db`; all other `.sterling/` files are editable.

### DELETE — 17 hook families + apparatus

H3, H4, H5, H6, H8, H9, H13, H14, H17, H18, H21, H24, H25, H26, H27, H29 and H30; staged pipeline, review ledger/commit trailer and merge refusals, enforcement self-protection, config allowlist, council and pipeline skills. H29's consult-result check is not rebuilt: every Codex dispatch writes `-o`, which the conductor reads, so a missing answer fails loudly.

### Three harness-specific changes to the port plan

1. H10 uses 1,000,000-token windows for `claude-fable-5-1` and `claude-opus-5`; there is no `default` fallback, and an unmapped model reports the pressure figure as unreliable. Its warning is non-blocking: `systemMessage` plus next-prompt queue.
2. Touches come from git against persisted `.sterling/transient/git-settled.json`, seeded by H1 at session start; working tree, index and untracked changes participate. The delegation nag is gone.
3. The roster is implementor, researcher, scout and librarian (decision `f0893161`, superseding `87f5f982`); review is the other model family. Retired roles and their frontmatter/pipeline class machinery are gone.

### Roster shape and review pairing

Implementor owns the change and tests; researcher is read-only; scout returns a compact conclusion, path:line map, a few exact excerpts, coverage gaps and `ESCALATE:`; librarian remains update-only. Terra implements when selected; Sol reviews Claude work; Claude Opus reviews Terra work; Astra spars non-trivial designs. One sparse review before a commit covers the riskiest diff and every changed test in full, with a substantive final-diff response.

### Environment

Local SQLite only. Claude Code, Sterling, Codex and projects run in WSL2; Windows launchers open WSL. `packages/store` uses `journal_mode=DELETE` for `/mnt/<drive>` stores.

Terra lanes that must run the test suite use the user-approved `--dangerously-bypass-approvals-and-sandbox`, because Codex's sandbox blocks their child processes; Sol remains read-only.

### Sequencing

Cut first; accept it in a real Dome Farmer consumer session; then fix surviving consumer defects. Converge on OpenSterling's knowledge core rather than rebuilding it twice.

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

DONE for WSL authoring, launcher/init repair and native WSL tooling. `codex login status` is logged in via ChatGPT; Claude login is complete because this session runs in WSL. REMAINING: copy or symlink Windows domain stores into WSL; decide SpaceExplorer prune vs re-init; finish Dome Farmer Blender MCP networking/`uv`; run the first real WSL consumer session.

### Slice 2 — THE CUT

DONE except acceptance. Close-out, Slices 3, 4 and 5+8 landed in checkpoint `8df86a6` (127 files) on `takeover/h15-one-rule-and-config-set`; the earlier deletion commits are `31d0638`, `1896065`, `a83f5be`, `cee6797`. The close-out swept residue, deleted `grill-plan-flags`/`council.workflow`, rewrote the hooks README, repaired stale comments, regenerated `architecture.md`, and removed the dead `signals` set from `scripts/architecture-projection.mjs` (the brain is deleted). Five article gaps remain: board item `f72e5982` covers registry-set record types, hooks, tools, toolchain adapters, `packages/store`, `packages/tui`, and H2/H22/H31.

Knowledge base: 11 feature articles (from 7), adding `knowledge-capture-loop`, `session-start-h1`, `project-init` and `sop-commands-and-skills`; reconciled `knowledge-delivery`, `agent-distribution`, `project-configuration`, `conduct-contract-propagation` and `consistency-check-battery`. `87f5f982` is superseded by classless four-agent roster decision `f0893161`; this session also records agent retirement (`39e27cc5`) and Codex dispatch while Claude usage is short (`ff9937f3`).

### Slice 3 — conductor context diet

LANDED in checkpoint `8df86a6`; its delivery residual is replaced by Slice 3b. `CLAUDE.md` is 15,359B; `docs/conductor-contract.md` is 10,234B and H1 injects it on every source with a loud fallback; `target-claude-md.md` is rewritten. `board_query`/`maintenance_query` default to `projection:"text"`; tool descriptions fell from 38,377B to 17,326B; the largest governed Read is 2,905B. The capped assembler rebuild landed with its frozen-pins invariant, but the resulting delayed-delivery design is now being removed.

Pre-commit review: Sol review 1 requested changes (4 CRITICAL, 4 HIGH, 1 MEDIUM); Terra fixed them and the full suite reached 3,013 tests with only four known pre-existing failures. The conductor overruled Sol C1 on unreachable settled SHA after rebase: mint one durable item, emit loudly and advance rather than retain the old snapshot and jam H10 (`c87e6e0d`). Independent Sol review 2 found two new HIGH issues: stale queue-lock reclaim race and pinned ordinary headers bypassing the total cap (12,888B reproduced); the fixes landed in `8df86a6`.

### Slice 3b — knowledge delivery migration

IN PROGRESS. Decision `92088a62` (`knowledge-delivery-target-design-no-delayed-delivery`) adopts Astra's full review: delete delayed delivery—the prompt rung, drain, queue, lock and cached fallback; use explicit emission metadata rather than scanning text for IDs, avoiding a persistent false `delivered` mark; distinguish discovery from substance marks; keep hazards whole with an honest three-per-package limit; charge final context; and give Codex lanes no automatic delivery, so briefs carry records by hand. Step 1 checkpoint is DONE (`8df86a6`). Step 2 removes delayed producers (board `7b4d9f3a`, IN PROGRESS on Terra); step 3 adds the assembler contract and marks (board `4c32af48`); steps 4–5 settle timing/context ownership, run WSL probes, then delete dead machinery (board `8a3948a7`).

### Slice 4 — touches from git, gauge with the right window

DONE — landed in `8df86a6`. Git touches use the persisted settled snapshot, seeded by H1. Fable and Opus use 1,000,000-token windows; no default fallback exists, so unmapped-model pressure is explicitly unreliable. Pressure is non-blocking (`systemMessage` + next-prompt queue), and the delegation nag is removed. Decision records: `c87e6e0d`; finding `4f385d7a`.

### Slice 5 — roster to OpenSterling's shape

CLOSED — landed in `8df86a6`, together with Slice 8. The roster is implementor/researcher/scout/librarian (decision `f0893161` supersedes `87f5f982`); skills include `delegating-to-subagents`, `design-research`, `decision-records`, `closing-out-tasks` and `review-brief`. `sync-agents` ran on Sterling-main and Dome Farmer: it retired the nine old roles (coder, debugger, explorer, implementation-architect, test-writer and reviewer-*), installed implementor and scout, and refreshed researcher and librarian. The running session already lists the new agents and skills, so no restart was needed. Sync retires unregistered Sterling agents only on matching identity and hash (decision `39e27cc5`, Astra-sparred).

### Slice 6 — /sterling:update reaches agent sync on consumers

NOT STARTED. After the commit/sync/restart, make update reach agent sync on consumers, with continuation/reporting that prevents a skipped or sibling-blocked Dome Farmer sync from claiming it is current.

### Slice 7 — Dome Farmer defects that survive the cut

NOT STARTED. Re-verify post-cut groups, including new item `01fbe880`: `knowledge_create` accepts dangling link IDs. I-01's repeated capture root cause is `h10-direct-capture.mjs:1761`: pending is carried only when the other duties are satisfied. Then address the remaining reconciliation minting, array/history, maintenance-close, reference-delta and librarian-drain groups.

### Slice 8 — port what OpenSterling already settled: agents and skills

CLOSED — landed in `8df86a6`; see Slice 5. Agent templates and the five ported skills are in place, and safe retirement during sync is implemented and run on both named projects. Codex CLI derived `.codex/agents/*.toml` and root `AGENTS.md` from the Claude files; the latter's `Claude Code`→`Codex` rewrite corrupts slugs. Both derived outputs are gitignored (finding `44f0645d`, inferred).

## External-model consult log

**Astra round 2 — plan review, 2026-09-19.** Every slice was PARTIAL at review time. Astra's FATAL finding was delivery after action; the conductor downgraded it because all three live project configs already used `read`, while still shipping the corrected default. ADOPTED and built: `read` default, Bash tool-time delivery, drain dedup+cap, non-blocking pressure, snapshot seeding, H1 trim, agent retirement and article coverage.

DISAGREED, conductor call stands: H29 consult-result checking is not rebuilt because Codex `exec -o` makes a missing answer loud; capture/article duties remain blocking once each because they enforce knowledge capture.

**Astra round 3 — knowledge delivery review, 2026-09-19.** ALL ADOPTED in decision `92088a62`: no delayed delivery; explicit emission metadata; separate discovery/substance marks; whole hazards with a three-per-package limit; final-context charge; and no automatic Codex-lane delivery. The conductor verified Astra's load-bearing claims against the board `7b4d9f3a` reproductions; no disagreement remains.

**Sol pre-commit reviews — 2026-09-19.** Review 1: REQUEST_CHANGES (4 CRITICAL, 4 HIGH, 1 MEDIUM), all fixed by Terra; the suite reached 3,013 tests with four known pre-existing failures. Review 2, independently redone on `gpt-5.6-sol`: REQUEST_CHANGES with two HIGH findings—the stale queue-lock reclaim race and pinned ordinary headers bypassing the cap (12,888B reproduced). A fresh Sol review follows the rebuild.

**Codex execution provenance — 2026-09-19.** Anti-pattern `codex-exec-resume-drops-session-model` (`23030b62`): `codex exec resume` ignores the session model and uses config-default `gpt-6-astra` unless passed `-m`; `--last` can select another lane. Part of a fix round and one re-check therefore ran on Astra, partly self-reviewing Astra's fixes, and the review was redone independently on Sol. A background `codex exec` with prompt as an argument and no stdin redirect also waits forever (two lanes idle for over an hour); use `- < brief` or `</dev/null`.

## Open questions and user actions

- Domain-store copy or symlink from `C:/Users/chulf/.sterling/domains` into WSL remains open.
- SpaceExplorer (`C:/Users/chulf/Comsoft`) needs a prune-or-re-init decision.
- Dome Farmer's Blender MCP still needs WSL `uv` and networking to the Windows addon.
- Shared-core boundaries with OpenSterling still need explicit agreement before convergence work.

## Next order

Complete knowledge-delivery migration steps 2 → 3 → 4/5; then Slice 6; then the Dome Farmer acceptance session; then Slice 7, including board `01fbe880` and I-01 at `h10-direct-capture.mjs:1761`. Take board `f72e5982` (article coverage) whenever capacity permits. The remaining Slice 1 domain-store action stays open.
