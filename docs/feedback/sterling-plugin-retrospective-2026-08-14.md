# Sterling plugin retrospective — dome-farmer, 2026-08-14

**Session shape:** one long conductor-direct session on `feat/asset-pack-swap`. 14 commits, ~10 subagent
lanes, a root-caused pipeline defect, a full part-library regeneration (358 `.gltf`), and a maintenance
drain. Conductor context ran to ~68% of a 1M window.

**Predecessor:** `C:\Users\chulf\Desktop\sterling-plugin-retrospective-2026-08-09.md` (23 KB, two parts).
This file is a fresh account from this session's own receipts, not a revision of that one. Where an item
here repeats one there, it means the issue survived five days.

⚠ **Every claim below cites something from this session.** Where I could not verify a number, I say so.

---

## 1. WHERE STERLING GENUINELY HELPED — with receipts

### 1.1 H20 (mechanism-axis delivery) caught defects in MY OWN briefs, three times

This is the single highest-value thing the plugin did today. H20 fires when you dispatch an agent and
matches the *subject* of the brief, not the files touched. Three times it surfaced a record that made my
brief wrong **before the agent acted on it**:

| # | What I was about to do | What H20 surfaced | What it saved |
|---|---|---|---|
| 1 | Dispatch `test-writer` without pasting entry-point signatures | `16f6b58c` — a blind test-writer's ASSUMED signature does not produce a red test; gdUnit4's scanner hard-errors and **blocks every suite in the project** | A whole-suite outage landing on code the new tests never touched |
| 2 | Brief a render probe with the standard in-frame proof | `7e996bec` — `unproject_position` returns STRETCH-BASE coordinates here (3440×1440 basis), so the proof **rejects perfectly good plates** | At least one wasted windowed render round |
| 3 | Tell a librarian to "retransmit the whole array with only entry X changed" | `d25f5a9e` — retransmitting a large array from a token-capped read **silently truncates it**; the write succeeds with no warning. Its trigger section names *the instruction itself* as the defect | Silent destruction of a `files[]` array on a v53 concept article |

**Item 3 is the strongest case for the whole system.** The record did not just describe a hazard — it
described *the sentence I had just written* as the hazard. I sent a correction to the agent mid-flight
with the safe method, and it came back `7 → 7 entries, verified both ways`.

### 1.2 The store stopped me re-asking 44 questions the user had already answered

I was about to walk the user through 133 asset plates. H20 surfaced `6d1e8999` and `f5c9cdb5` — two
"group N of 10" decisions from 2026-08-13 in which the user had **already ruled on 44 of them**. Without
that, I would have asked the user to re-decide 44 rulings they had made the day before.

The rotation note had said "DONE: 2 of 133". The store said 44. **The store was right and the note was
stale** — see §3.1.

### 1.3 `capped: true` disclosure is honest, and agents used it correctly

Every `knowledge_query` returns `{matched_filter, returned, cap, capped}`. Two different agents reported
`capped: true` unprompted and explicitly declined to claim exhaustiveness ("I hold a window, not the
set... I have NOT established that nothing else in the other 566 governs this work"). That is exactly the
behaviour you want, and it is the schema's doing, not the agents'.

### 1.4 `capture_pending` / `no_capture` let me be honest instead of fabricating

Three times H10 demanded a capture when the honest answer was "the capture exists and is landing later"
or "this is a projection of four records already stored". Both tools exist, both record the reason, and
both are better than the alternative of inventing a record to satisfy a gate. **This is good design.**

### 1.5 The `knowledge_create` dedup gate forced a real justification

I tried to create an anti-pattern about a landing assertion missing orientation. The gate refused —
0.32 Dice similarity against `a15c7f30` — and offered "same finding: update it" or "distinct lesson:
`dedup_override: true`". It made me articulate *why* it was distinct (that record is about a MIRROR
whose decomposition is ambiguous; mine had no mirror at all, and a reader following it would hunt a
negative determinant that does not exist). The override was right, but the gate improved the record.

### 1.6 H10's article demand produced two owning records that would not otherwise exist

`demo-scene-mount-reader` (a new feature article) and `f9d95744` (a `reference_material` for the tracked
inspection ledger) were both written because H10 refused to let unowned files pass. Both are load-bearing
now.

---

## 2. WHERE STERLING CAUSED FRICTION OR MADE THINGS WORSE

### 2.1 ⚠ H10 fires on FILE TOUCHES, not on LEARNING — and it cannot tell the difference

This was the single most repetitive friction of the session. H10 fired **at least eight times** with
"direct-mode work touched N file(s) but nothing was captured". On several of those turns the work was:

- reading a log file to get a test count,
- running `git status`,
- editing one line of a comment,
- writing a file whose content is a *projection* of four decisions already in the store.

**The duty is real; the trigger is wrong.** "Touched a file" is not "learned something durable". The cost
is that the conductor either writes junk records to satisfy the gate, or spends a tool call and a
paragraph on `no_capture` explaining why not — and I did the latter three times, at maybe 400 tokens
each, on turns where nothing had happened.

**Suggested fix:** weight the demand by what changed. A one-line comment edit, a log read, or a file whose
diff is <20 lines should not arm the same demand as a new class or a decision-bearing change.

### 2.2 ⚠ H21 counted my writes and never looked at their size

H21 ("article application is librarian-shaped") fired **11 times**, each saying hand-run writes are for
three named exceptions only — while every write I made *was* one of those exceptions: a small authored
create, a single small-record touch, or a write needing live adjudication. It counts `knowledge_*` calls
and does not distinguish a 3-word `knowledge_edit` from a full article rewrite.

By write #9 I was ignoring it, which is the worst outcome for a nudge: **a hook you learn to ignore stops
protecting you at the moment it is finally right.**

### 2.3 ⚠⚠ The watchdog cron contradicted a live user ruling, all session

Every watchdog tick said **"the ceiling is 10 concurrent subagents"**. The user set the ceiling to **15**
early in the session, I recorded it as decision `3c77d757` and wrote it into CLAUDE.md — and the tick text
kept saying 10 for the rest of the day.

**A recurring prompt with a hardcoded number that a user ruling can override is a drift generator.** It
should read the value from config, or state no number and point at the rule.

### 2.4 The board is unusable and Sterling has no affordance for it

`board_query source:"user"` returned **`matched_filter: 191`** with my `cap: 60` — `capped: true`. The
project's own rule says *"a board too large to read is a board nobody will audit. Prune on sight."*

**The proof that it is failing: I ran this entire session — 14 commits, four agent lanes, a root-caused
defect — without reading the board once**, navigating by the rotation note and memory instead. When I
finally read it, it immediately told me three things I needed (the icons slice is ruled-and-ready, the
animation slice exists, the garage re-anchor is half done).

There is no prune command, no staleness signal, no "this item's evidence no longer matches HEAD" check.
I boarded the pruning work as an item — which grows the board by one to fix a 191-item board.

### 2.5 `rank_terms` do not narrow, so `capped: true` is the normal state

`knowledge_query types:["anti_pattern","decision"] rank_terms:[...]` returned `matched_filter: 606`,
`607`, `605` on three separate calls. The note explains correctly that rank_terms *order* the filtered
set and never narrow it — so with two broad types, **the filter is "every decision and anti-pattern in
the store"** and `capped: true` is unavoidable.

The disclosure is honest (§1.3) but it is *always* true, which trains readers to stop reading it. What is
missing is a way to actually narrow: a `rank_threshold`, or a `must_match` term, or simply having
`rank_terms` filter when more than N records match.

### 2.6 Records cite each other by 8-char prefix; `knowledge_get` needs the full uuid

There is an anti-pattern about this (`decae4de`) — which is itself an admission that the store's own
citation convention is incompatible with its own lookup tool. I hit it repeatedly: every record says
"see `6583675b`" and every lookup needs `6583675b-3dbe-4a1c-bf0b-eabfd6785292`. Resolving a citation
means a query-then-get, or luck.

### 2.7 Every update mints a new id, so ids in prose are born stale

Consequences seen today:
- A librarian hit `supersede: record ... is already superseded` because it reused an id from two writes
  earlier in its own task.
- Records must be resolved "by TITLE" or "by slug", which several records say explicitly — a workaround
  documented so widely it is effectively part of the API.
- I cited `620f5884` in an agent brief; by the time the agent read it, the id was superseded and the
  agent had to find `2f8716b2` itself. It did, and said so, but that is luck plus diligence.

### 2.8 `knowledge_edit` works only on strings, and the array case is where you need it most

`files[]` and `current_ac[]` are arrays of objects, and they are exactly where stale prose lives (a
`role` string, an AC's `text`). `knowledge_edit` refuses them; the alternative is `knowledge_update` with
the whole array, which is the truncation hazard of `d25f5a9e`. **The tool that is safe cannot reach the
data, and the tool that can reach it is dangerous.**

What would fix it: `knowledge_edit` with an element selector — `field: "files", where: {path: "..."},
subfield: "role", find/replace`.

### 2.9 `reference_material` required fields that CLAUDE.md's own list does not mention

`knowledge_create` rejected my `reference_material` for missing `source_date` and `capture_date`. The
project's field notes describe `research_finding`'s two clocks in detail and say `reference_material`
"carries none and derives its path from `location`". One rejected write, easily avoided by
`knowledge_schema` — but the local documentation actively pointed the wrong way.

### 2.10 History rotation silently drops entries

`knowledge_append` on `history` returned: *"history rotated: kept the newest 20 of 21 entries"*. It says
so, which is good. But an article's history is the one place where the OLDEST entry is often the most
valuable — `mech-part-export`'s history is what proved a count had been re-quoted three times without
re-measurement (§3.2). Rotating from the old end destroys exactly that evidence.

---

## 3. WHERE STERLING DELIVERED THE WRONG INFO, OR NONE

### 3.1 ⚠⚠ The store contradicted itself, and nothing detected it

**This is the most serious finding in this document.**

Decision `6583675b` (2026-08-13, ~19:30) stated "Heavy + Lt + LtMed share ONE 17-bone family with 56
interchangeable clips". Decision `af625650`, written **eleven hours earlier the same day**, had already
corrected exactly that measurement and ruled them **two families that never share clips**.

Both records were `status: active`. Both would be returned by a query on the topic. The later, wrong one
read as the more current. **No hook, gate or query surfaced the contradiction** — it was caught only
because a human-written rotation note flagged it as a risk.

The store has versioning, supersession and a dedup gate on *creation*, and nothing at all that notices
two active records asserting opposite things about the same measurement.

### 3.2 Articles rot, and the rot is invisible to every existing mechanism

Counted this session: **ten stale numbers corrected** across three articles and two source files.

- `mech-part-library`: seven stale figures in one record — `339` (real: 351), `346 exported` (358),
  `45 held back` (33), `323 + 23 = 346` static/skinned (324 + 34 = 358), `45 held-back rows` (33),
  `346 .gltf on disk` (358), and "the current 346-part library" (358).
- `mech-part-export`: file count quoted as **330, then 336, then 339** — *three re-quotations without a
  single re-measurement*, against a real value of 358. Plus "24 diverging sockets" (27) and
  "137 of 330 carry sockets" (158 of 358).
- `game/run/trader_deck.gd` and `game/mech/mech_part_library.gd`: comments asserting a deleted file
  (`part_catalog.gd`, deleted at `1fa576f`) was still the live catalogue.

**Why nothing caught it:** the tests assert the *identity* (`fittable == exported − excluded`), not the
literal — which is correct testing and is precisely what removes the only mechanism that could contradict
the prose. Captured as `anti_pattern 41844c45`.

**What would have caught it:** a record field that names the command producing a number, and a hook that
re-runs it. `"measured_by": "grep -c ... manifest.json"` plus a staleness check is not hard, and
`research_finding` already has the two-clock concept — it just is not applied to numbers inside articles.

### 3.3 An article asserted, in its own acceptance criteria, the premise its own body said was false

`mech-rig-families` AC3 read *"The map is keyed on bone count and bone names"* while the same article's
body said, at length, that this premise had been **falsified by measurement** and the map is keyed on
`clip_family.id`. Both shipped in one record.

`knowledge_update` does warn when it detects a self-contradicting shape — but the warning is not a gate
and it did not fire here.

### 3.4 A record I wrote was wrong about its own mechanism until the fix was carried out

I captured `0d3ca823` saying the exporter *invented* a rotation. Carrying out the fix proved it **kept the
imported FBX value and never read the vendor's**. The difference is not academic: "we made something up"
sends you to delete a line; "we read the wrong source" sends you to the right one. I fixed it forward.

**This is not Sterling's failure** — it is what capture-at-the-moment-of-decision costs, and the store
made the correction cheap. Worth recording as the honest counterweight to §1.

### 3.5 A phantom maintenance item that regenerates forever

`242d1987` demanded reconciliation because an article's `files[]` named
`scratchpad/asset-swap/mech-census/build_recipe.py`, which "no longer exists". Investigation: it was
**never tracked** — `scratchpad/` is gitignored at `.gitignore:73` and git holds zero files under it.

So an article registered a path inside an ignored scratch directory, and the file-existence check will
raise that item **every time the scratch is cleaned, forever**. Nothing warned at registration time that
the path was gitignored.

---

## 4. TOO MUCH INFORMATION / TOO LITTLE

### 4.1 H20 delivery is very large and mostly not used

Every `Agent` dispatch got roughly **3 anti-patterns with full TRIGGER and RIGHT WAY code blocks, plus 5
decision headlines with their rejected alternatives**. Rough estimate: 1,500–3,000 tokens per dispatch,
on ~10 dispatches.

Value distribution was extreme: **3 of ~10 deliveries were decisive** (§1.1) and the rest were
irrelevant to the brief — a lighting-probe anti-pattern on an exporter dispatch, a boolean-geometry
record on a librarian dispatch, `alien-generator-spec` on a mech-fitting dispatch.

The "matched on:" keyword list at the top of each delivery is pure noise: *"matched on: blender, weapon,
tools, mech_port, project, control, weapons, assets, output, vendor, chain, unity, print, scene, reader"*
tells the reader nothing and costs tokens every time.

**Suggestion:** deliver 1 anti-pattern and 2 decisions by default with a "N more, query for them" line;
drop the keyword list; rank by rank-term overlap with the brief's *verbs* rather than its nouns.

### 4.2 H19 re-delivers the same records on every touch of the same path

I edited `CLAUDE.md` three times and got the same ~9 anti-patterns each time. Same for
`mech_part_library.gd`. There is no session memory of what has already been delivered.

**Suggestion:** deliver in full once per session per record; thereafter a one-line "already delivered:
`<title>`".

### 4.3 The `mech-part-library` article body is delivered whole on every Read

That article is large enough that its H19 delivery on a single `Read` overflowed to a persisted file
(17.8 KB in one case). Reading one 20-line function cost the entire article.

**Suggestion:** deliver `what_it_does` + the ACs by default, with the rest behind a `knowledge_get`.

### 4.4 Too little: nothing tells you the store's shape

There is no "here is what the store holds for this objective" view. `matched_filter: 607` is a number, not
a landscape. `design-corpus` exists as a START HERE index for concept families, which is good, but there
is no equivalent for decisions — and decisions are the type CLAUDE.md itself calls "the most expensive
type to miss".

---

## 5. WHERE THE HOOKS DID NOT PERFORM

| Hook | What it did | What it missed |
|---|---|---|
| **H10 (capture)** | Fired reliably on every file touch | Cannot distinguish a comment edit from a new subsystem; fired ~8 times on turns with nothing durable |
| **H10 (article demand)** | Correctly demanded owners for 4 new files | Also demanded one for a `.png` under a gitignored output directory — territory that should never need an article |
| **H19 (path delivery)** | Surfaced the right articles on the right files | No dedup across a session; delivers whole large articles; and per this project's own CLAUDE.md, once delivered a quoted ruling *without its justification clause*, which reproduced the very gap it was meant to close |
| **H20 (mechanism axis)** | 3 decisive catches — the best thing here | ~7 irrelevant deliveries; noisy keyword list; no relevance threshold |
| **H21 (librarian shape)** | Fired 11 times | Counts calls, not sizes; every one of my writes was a named exception; trained me to ignore it |
| **H14 (agent allowlist)** | Kept agents inside the toolchain | `python` is not allowlisted, so every agent hosts text-processing scripts on *Blender's bundled Python* — workable but absurd, and it cost one agent an explicit note that it "could not follow one instruction in the brief" |
| **Watchdog cron** | Kept the six questions in front of me; genuinely useful cadence | Hardcoded "ceiling is 10" contradicted a same-session user ruling of 15, all day |
| **Nothing** | — | **No hook detected two active decisions asserting opposite measurements (§3.1)** |
| **Nothing** | — | **No hook detected ten stale counts across three articles (§3.2)** |
| **Nothing** | — | No hook noticed the board at 191 items |

---

## 6. THINGS THAT WOULD HAVE HELPED

1. **A contradiction detector.** On `knowledge_create`/`update`, check whether an active record on the same
   `file_keys` or slug asserts an opposing measurement. Even a weak heuristic — same number-bearing noun,
   different number — would have caught §3.1 and §3.2.
2. **`measured_by` on any record field carrying a number.** Store the command; let a hook re-run it and
   flag drift. `research_finding`'s two clocks already prove the concept is understood.
3. **`knowledge_edit` with an array-element selector** (§2.8). This is the single most useful small API
   addition on this list.
4. **Session-scoped delivery dedup** for H19/H20 (§4.2).
5. **Board hygiene affordances**: a digest-by-default `board_query`, an age/staleness column, and a
   `board_prune` flow that walks items against HEAD.
6. **Config-driven watchdog text** so a user ruling cannot be contradicted by a recurring prompt (§2.3).
7. **A gitignore check at registration**: refuse (or warn on) a `files[]` entry whose path is gitignored
   (§3.5).
8. **Weight H10's capture demand by diff size** (§2.1).
9. **Resolve records by prefix** in `knowledge_get` — accept the 8 characters every record actually cites
   (§2.6).
10. **History rotation should drop from the MIDDLE, or never** — the oldest entry is often the proof
    (§2.10).

---

## 7. OTHER — process observations worth keeping

- **The `/loop` watchdog's six questions are genuinely good.** Question 3 ("what is blocked on the user —
  a question in prose has been DROPPED") caught me twice today holding a design question in prose. That is
  a real behavioural correction, not a nag.
- **The "an agent result is evidence, not a verdict" convention paid repeatedly.** Agents corrected my
  briefs four times today (the identity-vs-authored-rotation fix, the 62→58 plate count correction, the
  `resolution_method`-on-all-rows call, the refusal to guess a variant id remap). Every one of those was a
  brief of mine that was wrong.
- **Delegation genuinely protected context** — but the conductor still hit 68% of 1M. The dominant cost
  was *reading agent reports*, some of which ran to several thousand words. There is no affordance for
  "give me the 200-word version and keep the rest retrievable".
- **The store's decisions are the best artifact in the system.** `alternatives_rejected` in particular
  repeatedly told me what had already been tried and refused. That field is worth more than most of the
  rest of the schema.

---

## 8. VERDICT

**Sterling's retrieval layer is the strongest part and it earned its keep three times today** — each time
by catching a defect in a brief *I* had written, before an agent acted on it. That is a category of error
nothing else in the stack can catch, and it justifies the whole apparatus on its own.

**Its weakest part is that it has no immune system for its own contents.** The store versions, supersedes,
warns on self-contradiction within one record, and dedups on create — but two active records asserting
opposite measurements survived eleven hours and were caught by a human note, and ten stale counts across
three articles were caught only because a librarian looked slightly outside its instructions. **A
knowledge base that cannot detect its own rot puts the cost of that rot onto every future session**, and
this session spent a real fraction of its budget paying it.

**The hooks are tuned for reliability over precision**, which is defensible for a capture duty and wrong
for a nudge. H10 and H21 both fire so often against so little that they train the conductor to skim them —
and a hook you skim is worse than no hook, because it occupies the slot where a real warning would go.
