# Sterling plugin — what worked, what didn't, and what would fix it

**Written 2026-08-03, from one long dome-farmer session.** Everything below is first-hand
from this session or verified in it. Where a number appears, it was counted this session —
not remembered. Where I am relying on a record written earlier, I say so.

**Scope, honestly stated:** this is one session on one project, by one user, with a
knowledge base of ~232 decisions and 34 feature articles. It is not a survey. A few of the
failures below may be dome-farmer's configuration rather than the plugin's design, and I
flag those where I can tell the difference. I could not read the plugin's own issue history,
so some of this may already be known.

---

## 1. Where Sterling genuinely earned its place

### 1.1 It caught two contradictions that no amount of reading code could have found

This is the single clearest win, and it is worth being precise about why.

**The mech height.** Two `decision` records sat `active`, both with `superseded_by: null`,
with no link between them — one ruling the mech 5.9 m, one ruling it 3.5 m. The *code*
implements 5.9 m. Nothing in the repository knows there is a dispute. Without the store,
the next person to size a weapon mesh would have sized it against 5.9 m, correctly by every
available signal, and been wrong.

**The coop death view.** Same shape: `e0d1c0db` (2026-07-27, a dead pilot spectates a
living teammate's cockpit) versus `50e14ac1` (2026-08-02, a top-down death view). Both
active, no link. The user ruled, and the ruling went the *opposite* way from the height case
— the EARLIER decision won. That is exactly the kind of fact that has to be written down,
because "later wins" is the natural inference and it would have been wrong.

Neither of these is a bug the compiler, the linter, or a 562-case test suite can see. This
is the thing the store is *for*, and it worked.

### 1.2 `alternatives_rejected` is the highest-value field in the schema

Decision `6e174502` records that walls are ~4 m. Useful. What makes it *valuable* is the
rejected list: waist-high walls were rejected because *"you shoot over it freely, so it stops
the Veskari and not you — placing a wall becomes a pure gain with no tactical cost"*, and
7 m walls were rejected because they turn the farm into corridors.

Code can express the 4. Nothing in code can express why 2 was wrong. Six months from now
somebody will propose lowering that wall, and the answer is already written.

### 1.3 An article that admitted what it didn't know

The `housing` article was created at `state: planned` *while a coder was still writing the
file*, and its `files[]` role opened with **"⚠⚠ ROLE NOT YET WRITTEN FROM THE FILE."** Its
history entry said, explicitly: *"OWED: reconcile every files role and every AC from the
authored source."*

That caveat existed because the `garage` article had previously been written from an agent
brief instead of the code and had to be corrected wholesale. The author learned, wrote the
limitation into the record, and it worked: this session I found the flag, ran the audit, and
discharged it.

**A knowledge base that can say "I don't know this yet" is worth much more than one that
can't.** This is a design strength and it should be made easier, not harder — see §3.8.

### 1.4 Anti-patterns captured this session paid off inside the same session

Three were written and immediately mattered:
- `1f5c5395` — one concept with two membership tests. A rename function re-derived building
  membership inline, so half a feature was dead code **under a fully green suite**.
- `50bc67e9` — an agent spliced a new function between another function's docstring and its
  body, stealing two paragraphs. Every gate passed. This happened **four times** this session.
- `164ae3e7` — I briefed an agent to run gates it has no Bash access for. The resulting
  failure read as agent carelessness; it was my brief.

The third is the interesting one: the store caught **my** error, not the code's.

### 1.5 The `capped` field is the right design

`{matched_filter, returned, cap, capped, records}` is honest in a way most query APIs are
not. It tells you the window is a window. That prevents a whole class of "I searched and
found nothing" errors — and the project instructions record a sibling project that reasoned
from a 20-record window as if it were the whole store, three times, *before* this existed.

---

## 2. Where it did not deliver

### 2.1 H19 does not fire on Bash — and Bash is how the work actually happens

**This is the most consequential gap I hit.** The hook that injects owning articles when you
touch a file is wired to `Edit|Write|MultiEdit` and `Read`. The `Bash|PowerShell` matcher
runs different hooks entirely.

Almost all fast surveying in this project happens through `grep`, `wc`, `git log` and `awk`.
This session I ran roughly a dozen Bash investigations — counting enum members, checking line
counts, verifying paths across branches, confirming wiring — and **received zero knowledge
delivery from any of them.**

The project instructions already record an incident where a conductor surveyed a regression
almost entirely through Bash, got exactly one H19 injection in a whole session, and shipped a
fix into a hole the store had already documented. It cost a second round.

**Why this matters more than it sounds:** the retrieval-first rule says query before you
work. H19 is the safety net under that rule. But the net has a hole exactly where the
traffic is, and the hole is invisible — nothing tells you an injection *didn't* happen.

### 2.2 The maintenance queue over-fires, and I measured it

27 open items, `capped: false`, so this is the whole queue and not a sample. **Seven were
exact duplicate pairs** — same article, same file, same reason, same text, created **2-3
milliseconds apart**:

```
housing               16:25:26.368 / .365
farm-radio            16:25:15.556 / .553
farm-selection-panel  16:24:50.130 / .128
farm-layer            16:04:49.767 / .765
garage                14:23:08.174 / .172
damage-attribution    13:20:24.575 / .571
building-destruction  13:03:31.641 / .639
```

**14 of 27 items — 52% of the queue — representing 7 real obligations.**

They cost nothing extra to close (one write auto-drains both). What they cost is *judgement*:
`deep_threshold` trips early, the session-start warning shouts, and anyone sizing the drain
from the raw count sees roughly double the work that exists.

### 2.3 One class of item can never be closed, and re-fires forever

The `world-generation` article owns `game/world/terrain.gd`. That file is parked on an
unmerged branch. Timeline, from the records themselves:

- **06:24** — a drain appended a full, correct negative-result entry: the file is not
  deleted, it lives on `feat/terrain-heightmap` at commit `52d532b`, and *"DO NOT DROP
  `game/world/terrain.gd` FROM THIS ARTICLE'S files[]"*. The article re-baselined to v8.
- **07:28** — **a brand-new item fired against the same article, for the same file, with the
  same wording.** 64 minutes later.

The documented drain procedure says: write an artifact, the item auto-drains. That is true
for **hash-mismatch** items. It is false for **file-missing** items, because the trigger is
not staleness — it's absence, and no write makes a file appear.

Worse, the two look identical in the query output: both are `reconcile_needed`, both carry a
`feature_link`. Following the documented procedure on the second kind produces an endless
series of identical history entries — which is precisely the *"version bump claiming a
reconcile that added nothing is itself drift"* failure the same instructions warn against.
**Two rules in the same document collide on this shape, and neither mentions the other.**

### 2.4 The store cannot tell "deleted" from "on another branch"

Root cause of §2.3. Every existence and baseline check evaluates against the **currently
checked-out working tree**. A parked branch therefore reads as deletion.

This cost real work earlier in this session: I asserted as a "VERIFIED FACT" that two files
had been deleted, on the strength of `ls`. A librarian refused both writes. Git proved both
files were alive on an unmerged branch. **`ls` proves working-tree absence and nothing else**
— and the tempting "fix" (dropping the path from `files[]`) is exactly wrong, because the
path becomes correct again on merge.

### 2.5 Two records under one slug, and no way to remove either

`knowledge_query` for `multiplayer` returned **two** records. One is the live concept
article; one is a tombstone titled *"DUPLICATE of multiplayer — NOT retired, and cannot be."*
`runtime-architecture` has the same problem.

The tombstone's own text explains the trap, and it is a good one: `state: deprecated` is the
only retirement signal available, because `status` and `superseded_by` are **server-owned and
cannot be set from the tool surface**, and there is **no delete tool at all**.

It gets worse. A history entry on the live article records that retiring the duplicate *by
retitling it* made the **tombstone the newest record under that slug** — so H19 resolved
`multiplayer` to the tombstone and served **"RETIRED DUPLICATE — DO NOT READ THIS ARTICLE"**
as the authoritative answer for the concept. A whole article went dark, and the only fix was
to re-touch the canonical record so it would win on timestamp.

**And `knowledge_create` does not dedupe.** Every response says so in its own output:
`check_skipped: dedup-merge`, `reason: not_built`. The system tells you, every single time,
that the check protecting against this is not implemented.

### 2.6 Every write mints a new id, so every written-down id is a time bomb

`knowledge_update` returns a **new** id. Any id recorded in a comment, a brief, a board item
or a memory file is stale the moment that record is next touched.

This is not theoretical. The project's own instruction file cited a decision as `52a5989d`
for about a minute before a correction to that record minted a new id. This session the mech
spine went from `eeeaaaef` to `f6aa3166` in a single update — the user asked me for "the task
number" and the honest answer was *"here it is, but don't write it down."*

The workaround (resolve by title/slug) is correct and is what the project does. But it is a
workaround for an API that hands you an identifier it knows will expire.

### 2.7 The schema is only learnable by having writes rejected

Five separate rejections are documented in this project, on five different fields:

| # | Type | Field | Failure |
|---|---|---|---|
| 1 | `anti_pattern` | `title` | Required, undocumented |
| 2 | `decision` | `title` | Required, undocumented — same mistake, later |
| 3 | `feature_article` | `version`, `history`, `live_test_refs` | Required, undocumented |
| 4 | `feature_article` | `slug` | Required, undocumented |
| 5 | `feature_article` | `concept_family` | Documented as a *mark*; it is a **string** |

Plus `research_finding`, which has **no** `title`, **no** `file_keys`, and a
`volatility_hint` that is a closed enum (`fast｜medium｜stable`) — a write passing the
entirely plausible `"low"` was refused.

The rejections are *good* — they name the field and the expected type, and refusing beats
silently dropping data, which is what used to happen. But the only way to learn the shape is
to guess and fail, or to query an existing record and reverse-engineer it. The project
instructions now say, in as many words: **"THE CHEAPEST WAY TO LEARN A TYPE'S REAL SHAPE IS
TO QUERY AN EXISTING RECORD OF THAT TYPE AND INSPECT THE FIELD."** That is a workaround for a
missing schema endpoint.

### 2.8 `state` goes stale silently, and nothing notices

The `housing` article said **`state: planned`** and **`version: 1`**, with a `files[]` role
opening *"ROLE NOT YET WRITTEN FROM THE FILE"* — while the feature was **shipped, wired into
two live consumers, and verified by a 24-stage probe.**

An audit checked all 10 acceptance criteria against the code: **all 10 held.** The prose was
right. The *metadata* was the lie — and metadata is what a reader trusts first. Anyone
querying this article would have concluded a working feature did not exist.

Nothing in the system detects "article claims `planned`, owned file is 674 lines of working
code." The hooks watch content hashes; nobody watches the state field.

### 2.9 Reconcile fires on file hashes, not on relevance

24 of 27 items were `reconcile_needed`. After auditing every one: **four** needed a real prose
change. The rest were no-ops.

The reason is that a hash mismatch on `game/main.gd` — 2717 lines — fires items against every
article owning that path, regardless of whether the changed lines are anywhere near what those
articles assert. This session, editing garage interactivity and adding two housing constants
fired reconciles on `building-destruction` (which is about chunk cutting and rubble),
`world-visuals` (wall boxes and the leak marker) and `dev-toolchain-setup` (LSP setup).

None could possibly have been affected. All three needed a write anyway.

### 2.10 One article will fire a reconcile forever, by construction

`dev-toolchain-setup` owns `game/main.gd`. Its own `files[]` role says the entry is
*historical* — a leftover from proving the LSP could resolve symbols — and redirects the
reader to three other articles for `main.gd`'s actual behaviour.

So: it owns a 2717-line file it makes no claims about. Every future edit to that file, for
any reason, enqueues an item against it. Every one will be an already-paid no-op. **Forever.**
Nothing flags a `files[]` entry whose own role text disclaims ownership.

### 2.11 Query output overflows into a file you then have to parse yourself

A `knowledge_query` for feature articles returned **293,516 characters** and spilled to disk
with instructions to read it in chunks. Because the JSON is one line, `Read`'s
offset/limit chunking doesn't work on it — the tool result says so itself.

I got what I needed with a `node -e` one-liner. That is fine for me; it is not fine as a
design. The failure mode is that the *natural* recovery — read the file back in — is the one
that blows up your context, which is the exact resource the whole delegation architecture
exists to protect.

### 2.12 The `librarian` role cannot close the items it exists to drain

Found while writing this document. `librarian` is the agent defined for exactly this job —
*"drains reconcile queues… applies conductor-drafted article updates verbatim."* I gave one
eleven history entries to append and three maintenance items to remove.

It applied all eleven correctly, then reported:

> *"I do not have a `board_remove` tool available in this session… I did not call a tool I
> don't have, so these three items are still open."*

Its tool set is `knowledge_query`, `knowledge_get`, `knowledge_update`, `knowledge_append`
and `maintenance_query`. **It can read the maintenance queue and it cannot remove anything
from it.** Every item without a `feature_link` — `article_missing`, `capture_owed` — is
therefore unclosable by the one role built to close it, and has to come back to the conductor.

The agent's behaviour was exactly right, and it is worth saying so: it refused rather than
improvising, and named the gap precisely. That is the failure handled well. But the role is
one tool short of its own job description.

---

## 3. What would fix these

Ranked by (damage prevented ÷ effort), best first.

### 3.1 Wire H19 to the Bash/PowerShell matcher — **highest value, low effort**
Parse file-like arguments out of the command string (`grep -n X path`, `wc -l path`,
`git log -- path`) and run the same delivery that `Read` triggers. Even a crude regex for
`[\w/]+\.\w+` filtered against files that exist would close most of the hole.

Cheaper interim: when a Bash command mentions a path an article owns, emit a one-line
*pointer* rather than the full article. **"`game/farm/housing.gd` is owned by `housing`"** is
90% of the value at 5% of the tokens.

### 3.2 Dedupe maintenance items at enqueue — **trivially fixable, 52% of the queue**
Key on `(article_id, file, reason)` and refuse a second insert within a short window (a few
seconds is plenty — the observed gap is 2-3 ms). If the duplicates come from two hooks both
firing on one event, one of them is redundant.

### 3.3 Distinguish "parked on a branch" from "deleted" — **fixes an unclosable item class**
Before emitting a deletion item, run `git cat-file -e <branch>:<path>` across local branches.
If the file exists anywhere, emit a *different, informational* reason — `file_parked` — that
does not demand a reconcile and self-closes on merge. If it exists nowhere, the current item
is correct and now trustworthy.

**Second-order benefit:** this removes the trap where the obvious fix (dropping the path)
silently corrupts the article.

### 3.4 Build the dedup check that `knowledge_create` already reports as skipped
`check_skipped: dedup-merge / not_built` appears in every create response. Refuse a create
whose slug already exists, or return the existing record with a warning. This alone would have
prevented both known duplicate-slug incidents — including the one where a tombstone became the
authoritative answer for a live concept.

### 3.5 Make slug the resolution key, not just a field
`knowledge_get <slug>` returning the newest record under that slug would eliminate the entire
stale-id problem (§2.6) and every workaround built around it. Keep ids for provenance; stop
making humans quote them.

### 3.6 Ship a schema endpoint — `knowledge_schema <type>`
Return required fields, optional fields, types, and enum values. Five documented rejections,
five different fields, and an instruction file that now tells you to reverse-engineer the
schema from existing records. One read-only endpoint retires all of it.

### 3.7 Make reconcile relevance-aware
Two options, cheap to expensive:
- **Cheap and useful now:** include the changed hunk ranges in the item text. *"main.gd
  changed at lines 2283-2290, 381-383"* lets a reader dismiss an irrelevant item in seconds
  instead of auditing an article.
- **Better:** if an article's prose cites `file:line` ranges, only fire when a changed hunk
  intersects one — or fire at a lower severity when it doesn't.

Also worth adding: flag a `files[]` entry whose role text disclaims ownership, so §2.10's
forever-item gets noticed once instead of re-audited forever.

### 3.8 Add a state-honesty check
If an article says `planned` while its owned files exist and exceed some trivial size, or says
`built` while they don't exist at all, enqueue a `state_review`. This is the check that would
have caught `housing` sitting at `planned` over a shipped feature.

And make §1.3's good behaviour cheap: a first-class `unverified: true` flag on a `files[]`
entry, cleared by the reconcile, beats a `⚠⚠` in prose that only helps if somebody reads it.

### 3.9 Give retirement a real path
Either a delete tool, or make `state: deprecated` exclude a record from query results by
default (`include_deprecated: true` to opt back in). Today, retiring a record makes it *more*
visible — it stays in every result set, and if it's the newest under its slug, it wins.

### 3.10 Give `librarian` `board_remove` — one line of config
It already holds `maintenance_query`, so it can see the queue. Without `board_remove` it
cannot close any item lacking a `feature_link`, and the conductor has to finish its work.
If the restriction is deliberate — to stop an agent deleting board items — then scope it:
allow removal of `source: "system"` items only, and leave the user's work board read-only.

### 3.11 Cap query output by projection, not by spilling to disk
Add a `fields` parameter so a caller can ask for `[slug, title, state]` across 34 articles
instead of 293 KB of full records. Most queries are "which article owns this / what exists",
not "give me everything."

---

## 4. Net assessment

**Sterling made this session better, and the two contradiction catches alone justify it.**
A wall height with its rejected alternatives, a design ruling that survived the session that
made it, an article honest enough to flag its own unverified fields — none of that is
reachable from a repository, and all of it changed what got built today.

**The failures cluster into two causes, and neither is about knowledge management:**

1. **The mechanism watches the working tree, not the repository.** Parked branches read as
   deletions; hash mismatches read as staleness. Every §2.3, §2.4, §2.9 and §2.10 symptom is
   this one assumption.
2. **Identity is by mutable id rather than stable slug, and creation doesn't dedupe.** That
   produces the duplicate slugs, the stale-id workarounds, and the tombstone-wins-retrieval
   failure.

Fix those two and most of §2 goes with them. §3.1 (Bash delivery) is separate, and is the
single change I'd make first — because unlike everything else here, **its failures are
silent.** A duplicate queue item is annoying and visible. A missing knowledge injection looks
exactly like there being no knowledge.
