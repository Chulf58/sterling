<!-- sterling:begin generated (init and update rewrite this block; put project rules outside it) -->
## Sterling layer (generated)

The **knowledge base is the authority**, not this file. The conductor's posture is `agent-templates/conductor.md`, written for agy to `.agents/agents/conductor/agent.md`. Sterling root: `~/.gemini/config/plugins/sterling` (the installed plugin; expand `~` to the home directory), written `<root>` below. Rules for a host apply only under that host's heading.

### Authority and retrieval

- **The store holds what is true now.** Consult it before acting; it supersedes memory and any standalone document. If it is silent or contradicts itself, stop and ask.
- **What lives where:** what an area does and which files it owns → `feature_article` (filter by `file_keys`). Why, and rejected options → `decision`. What not to do → `anti_pattern`. Findings → `research_finding`; one that measured only part of its subject states the population and exclusions. External docs → `reference_material`. Work → `board_query`.
- **A query result is a window.** `capped: true` means more matched: raise `cap` or narrow. `knowledge_get` is the full read.
- **`knowledge_preflight(text)` is the pre-write conflict check.** Run it before drafting a record, before a design settles and before asking the user. It answers for a subject, not a path; a `verify_targets` verdict names records to open first. The matcher is lexical: use the store's own words, and re-ask once after an unexpected `ungoverned`.
- **Query the area before touching it, articles first, code second.** Delivery on file touch is a safety net only.

### Reconcile and capture

- **Every change updates the store before the work is done.** Reconcile every affected article: the owner of the touched files (`what_it_does`, acceptance criteria, `files[]`, history) and any article whose behavior or dependencies changed (`relies_on` / `relied_by`). New features get an owning article; renames rewrite `file_keys`.
- **Fix a wrong record forward** with `knowledge_update`. `knowledge_retire(id, in_favor_of)` is for duplicates only, or `reason: "feature_removed"` for a deprecated article whose files are gone. Ask `knowledge_schema`, don't guess. Versioned writes take `expected_version`; destroying paths need the full id.
- **Author records to be found.** Titles use the words a user would say; statements and triggers are short and carry the subject (search matches only those and the title); evidence goes in `guidance`, `right_way` or `rationale`.
- **Concept articles:** one `feature_article` per recurring concept family, marked `concept_family`. Create or update it the moment a design settles and register it with `concept_designed` (fallback `node "<root>/bin/concept-designed.mjs" --family <slug>`).
- **`no_capture` discharges the capture duty only.** If a write is still in flight, declare `capture_pending` with its target.
- **Knowledge is born structured.** Conductor knowledge goes straight into a record, never loose prose. Wanted work goes on the board (`/sterling:task`) and leaves only through the artifact that fulfils it. The maintenance queue is mechanism-detected debt; never park a task there.

### Conduct

- **A settled ruling is not a fresh choice.** Never offer options a decision already settles.
- **Cite rulings by slug** in durable text: `[slug] (knowledge_get <id>)`. Never show a person a bare id: write `name (id8)`.
- **Ask through the host's question tool** (AskUserQuestion, `question` or `ask_question`), after a `knowledge_preflight` on the subject. A ruling exists only if it came through that form; a prose answer is not one (user-stated 2026-09-22).
- **Instruction-file proposals replace memory.** Auto-memory is off. When the user states a lasting preference, draft a bullet in this file's style outside the generated block, check it is not already covered, and offer it at the next pause through the question form.
- **De-AI prose before it ships** (docs, records, PR and commit text, UI copy) with `node <root>/skills/de-ai-writing/scripts/check-ai-signs.mjs <file>`. Code and chat are exempt.
- **Solve, don't board.** Fix in-scope findings in-session; board only what cannot be done now, and say why. Board every user ask at intake, one item per ask, split by area with `blocked_by` under one `objective`; run unblocked lanes in parallel.
- **A commit that fulfils a board item pays it:** `board_remove` with the commit as `evidence` and an `outcome` (`done`, `dropped`, `superseded`, `duplicate`). Record the user's words verbatim. Rewrite a partly-done item; name the branch when work leaves the main tree.
- **Dispatch briefs carry `REVIEW-TERRITORY: ["path", …]`**: one line, a JSON array of repo-relative POSIX paths (a directory owns what is under it; no globs).
- **Sparring partner.** Before a non-trivial design (new mechanism, persistent state), ask an outside model where it disagrees. Advisory only: your solution stands, and the decision record notes the disagreement.
- **Store writes go through the MCP tools,** never shell scripts against `.sterling/`. Nothing but the MCP server writes `.sterling/sterling.db`; other files there are editable.
- **When the platform disagrees with the design, stop.** Report the contradiction with the doc reference and a loud fallback, then wait. Never copy record shapes or rosters into instruction files; the store is the census.
- **Report Sterling defects without asking:** `node "<root>/bin/report-issue.mjs"` with title, component, severity, observed, expected and evidence. The repo is public: each `--evidence` is a Sterling `file:line` or a quoted Sterling message, never this project's code or names. Feedback about Sterling states its version (manifest under `<root>`) and HEAD commit.
- **At a clean boundary say `READY FOR NEW SESSION` on its own line** (committed, rotation note written by `node "<root>/bin/rotation-note.mjs"`, nothing in flight); `EXIT AND RELAUNCH` if hook or MCP code changed.

### On Antigravity CLI (agy) only

- **Start with `agy --agent conductor`.** Plain `agy` runs hooks but starts no Sterling MCP server. If a Sterling tool is missing: (1) the session lacks `--agent conductor`: ask for a restart; (2) first turn of a correct launch: agy attaches MCP tools after the first turn, so ask for one short follow-up; (3) still missing later: report a setup fault and ask for `/sterling:sync-agents` and a restart.
- **Call Sterling tools as `call_mcp_tool{ServerName: "sterling", ToolName, Arguments}`.** Read-only roles use `ServerName: "sterling-ro"`. Others: `run_command`, `read_file`, `write_file`, `edit_file`, `invoke_subagent` (background), `send_message`, `ask_question`.
- **agy delivers no knowledge on file touch, and Stop duties can be left owed** (one `continue` per turn). Query first, reconcile each changed article yourself, and check `board_query` and `maintenance_query` at each slice boundary.
- **Nothing enforces the store-write rule on agy:** no deny on shell writes to `.sterling/sterling.db*`, and `tools:` cannot keep read-only roles off store-write tools.
- **`/sterling:<name>` is a file:** read `<root>/commands/<name>.md` and follow it with agy tool names. `CLAUDE_PLUGIN_ROOT` means `<root>`. There is no `/sterling:dashboard`.
<!-- sterling:end generated -->
