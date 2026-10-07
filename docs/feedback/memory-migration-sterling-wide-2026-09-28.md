# Memory migration: Sterling-wide instruction-file changes (2026-09-28)

Hand-off from a CONSUMER machine to the AUTHORING machine. Claude Code auto-memory is being turned off, and the memories are moving into instruction files. This machine cannot commit Sterling's own files, so the user ruled (question form, 2026-09-28) that the Sterling-wide changes come to the authoring machine as this document.

Measured against Sterling 0.18.18 (`.claude-plugin/plugin.json`), clone HEAD `4888300`. Every target file was read in full at that commit before drafting, so that no bullet repeats a rule that is already there.

How to apply: each entry gives the exact text, where it goes, and its source memory. Text marked **Replace** swaps out the quoted sentence. Text marked **Add** is new. Rulings are cited by date and by the user's own words. The source memories are in each project's Claude Code memory directory (WSL `~/.claude/projects/-mnt-c-Users-<user>-<Project>/memory/`, or the older Windows-era `.../C--Users-<user>-<Project>/memory/`).

Proposed bullets per target:

| Target | Proposed |
|---|---|
| `agent-templates/conductor.md` | 10 |
| `CLAUDE.md` | 1 |
| `AGENTS.md` | 1 |
| `templates/target-claude-md.md` | 0 |
| `templates/target-agents-md.md` | 0 (one defect report, see Defects) |

Why nothing goes into the `templates/target-*.md` files: every accepted cross-project candidate is about the main session's posture. `conductor.md` reaches every registered project through sync-agents. A template bullet reaches only new inits, and existing projects also need a `TARGET_LEADS` entry, plus an `INSERT_AFTER` entry for a new bullet, in `scripts/stamp-contract.mjs:40` / `:92`, then `stamp-contract --apply`. The one exception to watch is covered under entry C6.

Side effects of editing `conductor.md`:
- The render pin in `scripts/tests/portable-agents.test.mjs:121` (`'conductor.md': '9614a55'`) has to move to the commit that lands this prose. The test's own documented procedure covers this; see commit `0b3e820`.
- The pre-migration survey found all 10 installed `conductor.md` copies unmodified at v0.18.17, so sync-agents should refresh them cleanly.

---

## `agent-templates/conductor.md` (10)

### C1. Close-out states what was delegated and what was hand-done

- **Where:** the closing paragraph, line 122. **Add** this after the first sentence ("Close a unit of work with what changed, the evidence, who reviewed it, and the residual risk left open.").
- **Text:**

  > **Say what was delegated and what you did by hand**: the dispatches by kind, plus any hand-work outside the four-item limit above, named with the reason it stayed inline. Sterling registers dispatches mechanically, but nothing shows the user your delegation *choices*, so hand-work that should have been a dispatch stays invisible unless you disclose it. The user asked for this on 2026-08-09, verbatim: *"how many tasks have you done that should have been done by a subagent this session? using subagents should be noted somewhere."*

- **Source:** Sterling, `disclose-delegation-decisions.md`. User ruling 2026-09-28 (accepted for conductor.md).

### C2. Each Codex consult summary is at most 4 lines, no emoji

- **Where:** the "Astra is the solution-sparring partner" paragraph, line 92. **Replace** the last sentence, "Summarize each consult: question, partner position, action taken.", with:
- **Text:**

  > Summarize each consult in the session output as one plain block: a bold header line naming the partner and the subject, then **at most four lines**, up to two on what was asked and up to two on the answer and the action taken. No emoji and no decoration. The user wants every consult visible at a glance but compact, and rejected an icon as unprofessional (user-stated 2026-08-22).

- **Source:** Sterling, `loud-codex-consults.md`. User ruling 2026-09-28 (accepted for conductor.md).

### C3. Independent verifiers stay blind

- **Where:** "Brief quality is your product". **Add** a new paragraph after the one that starts "Every brief carries:" (line 61).
- **Text:**

  > **Keep an independent verifier blind.** A reviewer or verifier whose job is to check a conclusion gets the artifact, the claim and the acceptance bar, never the author's reasoning, the prior finding or the decision under test. Handing it the conclusion anchors it and defeats the double-check. This is the one exception to "assume zero inheritance" above: retrieval-first by default, deliberate blindness for independence.

- **Source:** Sterling, `subagent-kb-access-and-retrieval.md`. The retrieval-first half is already covered by CLAUDE.md "Stage retrieval before work" and conductor.md line 61. User ruling 2026-09-28 (accepted for conductor.md).

### C4. A source the user points at is read first, without a store-wide sweep

- **Where:** "Keep the turn going". **Add** a bullet after the "When you have enough information to act, act." bullet (line 42).
- **Text:**

  > - When the user points at a specific source (a reference repo, a file, a URL), the first read goes to that source: clone or open it, find the mechanism named, then design. Do not open with a broad `knowledge_query` or `board_query` sweep. Targeted reads still apply: the owning article of a file you will edit, and `knowledge_preflight` on the design. User-stated 2026-09-21, verbatim: *"Only view the repo sent, nothing else"*. The user said this after interrupting exactly such a sweep, because a store-wide pass before touching the named source reads as stalling.

- **Source:** KS dashboards, `pointed-repo-means-read-only-that.md`.
- **Note:** this fences CLAUDE.md "Stage retrieval before work" without overriding it. The memory itself keeps targeted store reads.

### C5. Admin consoles stay in the user's hands

- **Where:** "Risky actions and honest reports". **Add** a bullet after "Sending content to an external service publishes it..." (line 26).
- **Text:**

  > - An admin console the user operates (a hosting console, a low-code platform portal, a telephony admin UI) stays in the user's hands. Deliver the exact values and settings as a runbook and let the user click. Drive one with browser automation only when the user asks for it: "let's do X" is not "drive my console". User-stated 2026-08-31, verbatim: *"why would you use playwright??? You merge to github and then I setup the resources in Served"*.

- **Source:** Deepdots, `served-console-is-user-operated.md`. This rule covers three projects: Deepdots, Dataverse (Power Automate) and Genesys.

### C6. Never delete a user's file unasked

- **Where:** "Risky actions and honest reports". **Replace** the bullet "Look at the target before you delete or overwrite it." (line 27) with:
- **Text:**

  > - Look at the target before you delete or overwrite it, and never delete a file the user created or placed without their word, not even one that exposes secrets. State what is in it, recommend deletion or move it aside under a quarantine name, and let the user decide. Deleting it is only "reversible" if the user redoes the work, and that cost is theirs (incident 2026-07-15: a user-exported file holding live secrets was deleted unprompted, and recreating it cost the user work).

- **Source:** Dataverse, `never-delete-user-files-unasked.md`. The incident happened during Deepdots work.
- **Limitation:** subagents do not load conductor.md, so this reaches only the main session. The incident was a main-session action. If the author wants implementors bound too, the same sentence would also need to go in `templates/target-agents-md.md` Conduct rules, with a `TARGET_LEADS` and `INSERT_AFTER` entry. That is not proposed here.

### C7. Reply in English

- **Where:** "How the harness talks to you". **Add** a bullet after the first bullet (line 15).
- **Text:**

  > - Write to the user in English, even when their message or forwarded feedback is in another language. Quote non-English text and product UI strings verbatim rather than translating them, and leave product text in its own language. User-stated 2026-07-29, after a reply had matched the language of a forwarded message: English is the working language of the collaboration and of the project's own artefacts (instruction files, the store, commit messages).

- **Source:** Diesel priser, `communicate-in-english.md`. The Danish-UI part stays in the Diesel priser AGENTS.md (a project-level migration, outside this doc).
- **Note:** this is a user preference that ships to every Sterling consumer through conductor.md.

### C8. Before rebuilding a board item, check origin and open PRs

- **Where:** "Three surfaces, never collapsed" (line 106). **Add** this after the sentence "The **board** answers what is owed, leaving only through the artifact-write that fulfils it."
- **Text:**

  > Before rebuilding an open board item, above all when recovering a crashed or cleared session, fetch and check the base branch on origin and the open pull requests for work already shipped on it. Close any item a merged or open PR already covers. A board item left open after its PR shipped looks like unbuilt work: on 2026-09-25 a recovery session rebuilt a feature that was already open as a PR, and the duplicate had to be reverted out of merge conflicts.

- **Source:** CS Planner, `after-a-crash-check-main-and-open-prs-first.md`.
- **Note:** Sterling's own CLAUDE.md "Close-on-commit" already says "Re-verify an item against HEAD". This bullet extends that check to origin and open PRs, and it lives in conductor.md because the HEAD rule is not in `target-claude-md.md`.

### C9. GitHub access is machine-local; never erase credentials to fix a wrong-account error

- **Where:** "Git safety". **Add** a bullet after the push bullet (line 35).
- **Text:**

  > - How this machine reaches GitHub is machine-local: which git binary can push, which account a repo needs, whether a GitHub CLI is logged in to the right account. Read it from the project store's reference material, and never guess it. On an auth failure (a 403, or a 404 on a private repo, which is how GitHub answers the wrong account), fix the account selection the documented way and report it. Never log out of or erase stored credentials: that breaks every other project on the machine that uses the other account. Never print a credential.

- **Source:** three memories that share one subject:
  - CS Planner, `github-push-and-pr-from-wsl.md` (the Sterling-wide candidate)
  - Sterling, `github-push-credentials.md` (the "do not log out or erase" lesson)
  - Diesel priser, `github-accounts-and-auth.md`
- **Machine-local facts** (account names, the Windows-git push route, the credential-helper wiring, which CLI is logged in where) do NOT go into any shipped file. Put them in each affected project's store as `reference_material`, which is the local-only SQLite database and not in git. For facts true of the whole machine, the alternative is a user-level `~/.claude/CLAUDE.md` on that machine. CS Planner's Served deploy recipe stays with that project, per the triage.
- **Not proposed:** the CS Planner memory also says the org ruleset requires every PR review thread to be resolved (via GraphQL). That affects `skills/pr-review-loop/SKILL.md`, which is not a target file here; the author may want to check that the loop resolves threads. The skill's `gh api` dependency is also unusable where the CLI is logged in to the wrong account (triage, KS dashboards conflict 3).

### C10. Heavy jobs run one at a time

- **Where:** "Reuse warm agents; one writer per file". **Add** this to the end of the parallel-lanes paragraph (line 69).
- **Text:**

  > Parallel lanes share one machine's memory. Run heavy jobs (builds, a full test suite, a solver) one after another, never alongside each other or another lane's checks, and on a small VM check free memory between them. On 2026-09-23 the out-of-memory killer took down two sessions while a build, a test suite and parallel coder checks ran at once. User-stated, verbatim: *"go slowly so it doesnt happen again"*.

- **Source:** CS Planner, `wsl-memory-limit-run-heavy-jobs-serially.md`. The general part only; the concurrency flags, solver ulimit and worktree setup stay in the CS Planner AGENTS.md. The memory's line about the subagent shell allowlist is stale: the scale-down removed that allowlist.
- **Home:** the triage proposed `templates/target-claude-md.md`. conductor.md is chosen instead, because the conductor schedules lanes, and conductor.md reaches existing projects without a stamp-contract entry.

---

## `CLAUDE.md` (1)

### M1. Call out Sterling friction loudly and capture it

- **Where:** "Conduct rules (Sterling layer)". **Add** after the "When the platform disagrees with the design" bullet (line 38).
- **Text:**

  > - **Call out Sterling friction loudly, and capture it.** When a hook misfires, a tool refuses wrongly, config is ambiguous or delivery is noisy, say so explicitly in the session report, and capture it durably: a board item with the repro, or an `anti_pattern` or `decision` as fits. Do the workaround if you must, but never let it be the only trace. A silently absorbed workaround (rephrasing a command to dodge a hook false positive) hides a defect, and real-use friction is the signal for whether a change works (user-stated 2026-08-22).

- **Source:** Sterling, `loud-sterling-friction.md`. User ruling 2026-09-28 (accepted for CLAUDE.md).
- **Checked:** this does not conflict with the "may NOT add a new enforcement program" bullet (line 31). The capture is policy data or a board item, never a mechanism.

---

## `AGENTS.md` (1)

### A1. Targeted test suites; the full run only when asked or at merge

- **Where:** "## Conventions" (line 61). **Add** after the existing sentence. The section currently holds one plain sentence; a bold-lead bullet matches the Conduct-rules style used elsewhere in the file.
- **Text:**

  > - **Targeted test suites, not the full run.** Gate a change with the suites its diff touches. Run the full `npm test` only when asked or at merge (`/sterling:merge`). Full runs are long and hold the terminal while the user is trying to work, and for a slice diff the targeted suites carry the same signal (the user rejected unrequested full runs twice on 2026-08-22).

- **Source:** Sterling, `no-full-npm-test-unasked.md`. User ruling 2026-09-28 (accepted for AGENTS.md).

---

## Defects

### (a) `templates/target-agents-md.md:4` promises regeneration markers that do not exist

- The header comment at lines 3-6 says: *"Regenerated sections are marked; hand edits outside them survive regeneration."*
- No such markers exist. The template has no delimited block.
- `grep -n -i "regenerat|<!-- sterling:|marker"` over `scripts/init.mjs` and `scripts/stamp-contract.mjs` finds none.
- `stamp-contract.mjs` works by bold-lead bullet match (`TARGET_LEADS`, line 40), not by section markers.
- The triage's destination-mechanics survey says the same: after the first init, `init`, `update` and `sync-agents` never rewrite a whole AGENTS.md and use no delimited block.
- The comment ships into every newly-initialized project's AGENTS.md, where it tells readers something false about how their edits survive.
- **Fix:** reword the comment to describe the real mechanism: hand edits survive, and `stamp-contract --apply` replaces only named bullets whose text still matches a historical template version.

### (b) The TUI model swap re-stamps `content_hash` with no locally-modified check

- **Evidence:**
  - `packages/tui/src/main.ts:228-238` reads each installed agent file and writes back `dist.setInstalledModelEffort(content, {...})`, with no `isLocallyModified` call in that path.
  - `scripts/lib/agent-distribution.mjs:290-324` (`setInstalledModelEffort`) rewrites the frontmatter `model:`/`effort:` lines, then recomputes `content_hash` over the whole current file and re-stamps the header. Its own comment (lines 293-296) states the result is self-consistent, `isLocallyModified === false`.
  - `isLocallyModified` exists (`agent-distribution.mjs:221`) and is checked on the sync and refresh paths (`:473`, `:531`, `:607`), but not on the swap path.
- **Consequence:** a hand edit to an installed agent (for example a project's `.claude/agents/conductor.md`) is laundered by the swap into a file that reads as unmodified. The next template bump then lets sync-agents overwrite it silently, so the edit is lost with no refusal.
- **Status:** inferred from reading the code, not run.
- **Fix:** have the swap refuse, or at least warn loudly, when the installed file is already locally modified before it re-stamps the hash (P5).

### (c) H10 demands owning articles for files that were only READ

- **Evidence:** in the migration session's Stop feedback, H10 listed `articles: article demand — 15 touched file(s) no owner`. The files it named included:
  - `hooks/h10-direct-capture.mjs`
  - `hooks/h19-bash-delivery.mjs`
  - `hooks/h19-dispatch-staging.mjs`
  - `hooks/h19-knowledge-delivery.mjs`
  - `hooks/h20-mechanism-axis.mjs`
  - `.claude/settings.json`
- No lane in that session edited those files. The researcher lanes only read the hooks.
- **Consequence:** a read-only investigation produces an article demand at session end, which is noise the conductor must discharge or ignore.
- **Proposed direction:** the article-demand join should count write-class touches only (Edit, Write and other file-changing tools), not reads.

---

### (d) The handoff projection crashes on a `current_ac` of the `not_applicable` form

Evidence: re-running init in CS Planner (mode: work) on 2026-09-28 printed `handoff projection FAILED (exit 1)` with `TypeError: (r.current_ac ?? []).map is not a function at renderRecord (scripts/lib/handoff-projection.mjs:159:38)`, called from `buildHandoffFiles` (:231). The feature_article schema allows `current_ac` to be either an array of criteria or `{not_applicable: {reason, ruling_record_id?}}` (the knowledge_create tool schema shows both). renderRecord only handles the array form. So any project holding an article that declares its criteria not applicable gets an incomplete export: `architecture.md`, `rulings.md` and `docs/sterling/` are missing records. Proposed fix: branch on `Array.isArray`, render the `not_applicable` reason, and pin both forms in the projection's test.

## Not proposed (ruled out)

User rulings, 2026-09-28, question form:

- `save-plans-on-windows-path.md` (Sterling): dropped.
- `feedback_approach_first.md` (home-level memory directory): dropped.
- `skip-codex-in-this-project.md` (KS dashboards): dropped.
- `do-bounded-work-inline-when-warm.md` (KS dashboards): dropped.
- `feedback_notes_vs_todos.md` (Salesforce): dropped.
- `ignore-h10-context-pressure.md` (Salesforce): dropped.
- `feedback_note_means_todo.md` (Genesys, Windows-era memory directory, "note this" means a board item): dropped. It was on the accepted DROP list, and for the matching Salesforce memory the user answered, verbatim: *"notes have been removed, so it means nothing today. drop it"*.
- Everything from comsoft (dead project). Its `never-fable-agents.md` is covered by conductor.md line 78, "Every dispatch carries an explicitly pinned model".

Already covered, so not proposed:

- `ask-questions-via-form.md` (Dataverse) is covered by `CLAUDE.md:34` ("Ask, don't guess — through the AskUserQuestion tool") and `templates/target-claude-md.md:35`.

Outside the Sterling-wide candidate list, flagged for the author only:

- KS dashboards, `node-watch-misses-edits-on-mnt-c.md`. The triage marks its self-kill lesson as a *possible* cross-project candidate: a `pkill` pattern can match the shell running it, so it should be anchored and run in its own call. It was not in the accepted candidate list, so no bullet is drafted.
