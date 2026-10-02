# Sterling — whole-system assessment, 2026-08-20

Companion to `sterling-plugin-retrospective-2026-08-20.md` (session evidence). This file assesses the **design**.

Written at the user's request with a specific focus: **article length**. Their framing, verbatim: *"this project is the only project that have had that issue so far. i assume as we keep working it will only become worse and worse."* Both halves of that are, as far as I can measure, correct — and the second half is the important one.

---

# PART A — THE ARTICLE-LENGTH PROBLEM (the requested focus)

## A.1 The measurement

I did not want to answer this from impression, so I measured the three largest articles by parsing the spilled `knowledge_get` overflow files. **All three overflow the tool's own output cap**, which is the first finding.

| | non-history body | total incl. history | `history[]` | over the 60k gate? |
|---|---|---|---|---|
| `mech-part-export` | **67,568** | 101,215 | 33,626 / 20 entries | **yes** |
| `probes-mech-assembled-plates` | **71,005** | 91,676 | 20,650 / 20 entries | **yes** |
| `dev-toolchain-setup` | 48,465 | 67,734 | 19,251 / 17 entries | **no — under by 11,535** |

**⚠ First correction, and it is mine.** I said three times this session that `dev-toolchain-setup` was ~67,000 and near the gate. **That is its TOTAL. The gate excludes `history[]`.** Its body is 48,465 and it is comfortably under. I had read a total as a threshold figure. I have corrected the board item that carried the error.

**But note what that correction does not rescue:** a librarian still could not open the record in one call. **So a record can be under the oversize gate and still be operationally unreadable.** The gate is measuring the wrong thing for the failure that actually occurs.

## A.2 Composition — where the characters actually go

Percentages are of the prose body (`what_it_does` + `intended_behavior` + `state_reason` + `files[].role` + `current_ac.text`).

| category | `mech-part-export` | `dev-toolchain-setup` | `probes-mech-assembled-plates` |
|---|---|---|---|
| **correction / supersession prose** | **31,862 — 57.4%** | 11,383 — 28.6% | 23,983 — 37.7% |
| verbatim quotations | 2,583 — 4.7% | 570 — 1.4% | 1,225 — 1.9% |
| markdown tables | 0 | 0 | 0 |
| **load-bearing remainder** | 23,529 — 42.4% | 28,263 — **71.1%** | 39,481 — **62.1%** |

**My stated prediction was half wrong, and I recorded it in advance precisely so this could be checked.** I predicted that correction-stacking *plus duplicated quotations* would be the largest cuttable share, and that load-bearing content would be a **minority of the bytes**.

- ✅ Correction-stacking is indeed the dominant cuttable share — **57.4%** on the worst article.
- ❌ Duplicated quotations are negligible: **1.4%–4.7%**. I over-weighted them because I had noticed the same ruling in several records; the copies are short.
- ❌ Load-bearing content is a **majority** of bytes on two of three articles (71.1%, 62.1%). Only `mech-part-export` is genuinely more fat than substance.

So the honest answer to *"is there a lot of fat?"* is: **on one of the three, yes and it is most of it. On the other two, no — they are long because their subject is large, and the remedy there is structural, not dietary.**

## A.3 The finding that matters most: the worst article violates its own written rule

`mech-part-export` **contains, in its own prose, the rule that would have prevented 57.4% of its size**:

> `CORRECT THE FIELD... NEVER STACK A NEW FENCE ON TOP OF AN OLD ONE`

And it is 57.4% stacked fences. The rule is stated, agreed, correct — and **nothing checks it**, so it fails on every tired session, including mine tonight. I appended a correction block to an anti_pattern earlier in this very session rather than fixing its field forward, and I did it *twice*.

**This is the structural point and it generalises past this project:** Sterling has an excellent forward-fix primitive (`knowledge_edit` with an exactly-once `find`) and **no pressure whatsoever to use it in preference to appending.** `knowledge_append` and a "⚠ CORRECTED …" block are always the cheaper, safer-feeling move, because appending cannot break anything and rewriting a field can. **The API's risk gradient points directly at the behaviour that causes the obesity.**

## A.4 The second structural cause: `files[].role` is being used as a document surface

On `probes-mech-assembled-plates`, `files[].role` alone is **53,692 chars — 75% of the non-history body**, with individual role entries running **6,000–7,700 chars each**. The largest single one, for `mech_assembled_plate_probe.gd`, is **7,687 chars**.

That is not a role description. **That is an article, stored inside an array element of another article**, for 19 files at once.

Why it happens is easy to see and hard to resist: `files[]` is the only field that is **path-keyed**, and path-keying is what makes H19 deliver the text when someone touches the file. So the incentive is to put everything a toucher needs into `role` — because that is the field with a delivery mechanism attached. **The delivery design is shaping the storage design, and pushing it the wrong way.**

## A.5 The third cause: `history[]` grows monotonically and nothing ever prunes it

20, 20 and 17 entries, at means of 1,681 / 1,033 / 1,132 chars. `mech-part-export`'s history alone is **33,626 chars — larger than most complete articles in the store.** It is excluded from the oversize gate, which is defensible, and it is *not* excluded from the payload that overflows `knowledge_get`, which is why an "under-gate" article is still unopenable.

There is no rotation, no archival, no "history before version N is cold" concept. **A record that is edited often is punished with unreadability**, and the records edited most often are the ones about the most active code.

## A.6 Why dome-farmer and not the other projects

The user's observation is that this project alone has hit it. I think that is real and the causes are identifiable:

1. **A single objective has run for six-plus days** (`COMPLETE THE MECH ASSET SWAP`), so a handful of articles absorb every finding rather than new articles being minted.
2. **This project measures constantly** — it is asset work judged by eye, so every claim carries a number, a control and a residual. Those numbers date, which produces corrections, which stack.
3. **A deliberate and correct anti-drift culture.** This project's own CLAUDE.md demands corrections be recorded rather than silently replaced. That is *right*, and it is the direct cause of the 57.4%. **The plugin offers no way to honour that demand cheaply** — no "supersede this passage, keep it retrievable, but stop shipping it in the body".
4. **19 probe files documented through one article's `files[]`.** A Node/TypeScript project would have fewer, and would not be documenting render instruments at all.

**So the user's prediction is right, and worse than they put it:** the growth is not linear in time, it is **proportional to how much the project measures and corrects**. The better the anti-drift discipline, the faster the articles become unreadable. **That is a design flaw, because it penalises the exact behaviour Sterling is built to encourage.**

## A.7 What would actually fix it

Ranked. The first two are cheap and would have prevented most of this.

1. **A size signal at WRITE time, not queue time.** Every `knowledge_update` / `knowledge_append` response already returns `chars_before` / `chars_after`. Have it return a warning when a write crosses, say, 45k body — *"this article is 46,200 chars; consider `knowledge_edit` forward-fix instead of append, or a split"*. **Cost: one comparison. Value: the author is told at the moment they are making it worse.** Today you learn from a queue item long after the fact, and that queue item is undrainable.
2. **Make append the expensive-feeling option for corrections.** When `knowledge_append` targets a long text field, or when `knowledge_update` writes a body containing `CORRECTED`/`SUPERSEDED`/`STALE`, return an advisory naming `knowledge_edit` and the exactly-once `find` contract. This is the H21 pattern — advisory, non-blocking — applied where it would do the most good.
3. **`knowledge_split(id, {new_slug, fields|files_paths})`.** There is no split operation, so "split it" — which the queue literally instructs — is a manual, multi-call, error-prone job that nobody does. A split that carries `history` provenance and rewrites `files[]` ownership atomically would turn a standing instruction into a command. **Note the honest consequence of A.2: split helps `probes-mech-assembled-plates` and does almost nothing for `mech-part-export`, whose problem is trim.**
4. **Cold history.** `history[]` beyond the last N entries retrievable on request but excluded from the default `knowledge_get` payload. Would immediately make `dev-toolchain-setup` openable and cut `mech-part-export`'s payload by a third.
5. **A first-class `role` document.** If `files[].role` is going to be a delivery surface, give it a size discipline or let a path point at its own small record. 7,687 chars in an array element is the design telling you it wanted a different shape.

---

# PART B — THE REST OF THE SYSTEM

## 6. The record type system

**The types carve the space well and I would not collapse any two.** The distinction that earned itself this session was `decision` versus `anti_pattern`: a decision told me what was already settled and what had been rejected; an anti_pattern told me what mistake I was about to make. Those are different questions and merging them would lose the trigger/tell structure that makes anti_patterns actually fire in the reader's head.

**Best field used:** `alternatives_rejected` on `decision`, as `{option, reason}` objects. It is the one thing code can never tell you, and it stopped me twice from re-offering an option the user had already declined.

**Dead weight observed:** none exactly, but `anti_pattern` has a real gap — **it has no way to separate a durable LESSON from a dated CENSUS.** Two anti_patterns needed correcting this session (`6cdc8e05`, `5a3955fa`) and in both cases the lesson was perfectly valid and only the measurement had rotted. Both corrections had to be appended as prose, which is the A.3 mechanism in miniature. A `measurements[]` array with its own clocks, separate from `guidance`, would let the census be replaced without touching the lesson.

## 7. Identity, versioning, supersession

**This remains the most expensive design decision in the plugin, and it bit again tonight.**

Every `knowledge_update` mints a new id. Slug resolution mitigates it for articles. **Board items have no slug**, so a board item can only be referenced by an id guaranteed to change on the next edit. Concretely this session:

- `523cc308` → `9d91f1c8` → `f33dbbe3` (two edits, three ids, all within ninety minutes)
- `c1e88168` → `22a16d04`; `12ccff28` → `d17ec4d4`; `9626b233` → `6cd6ce66`

I wrote a rotation note citing board ids for the next session. **Several were stale before the note was consumed.** The store even contains an anti_pattern about exactly this trap (`5bf1cb1d` — auditing cited ids mostly manufactures false alarms, because a correct citation goes stale the moment its record is edited). **A design that needs an anti_pattern to explain why its own identifiers cannot be cited is telling you something.**

**The fix is small: give `todo` records a slug.** Everything else already has one.

## 8. The tool / API surface

**What worked well:** `projection: "digest"` is excellent and under-advertised — it is what made a 256-item board and a 47-item queue navigable at all. `knowledge_edit`'s exactly-once `find` contract is the right safety model. `knowledge_append` for arrays genuinely prevented the history-clobber it was built for. `board_remove` returning `artifact_evidence` is a quietly brilliant feature: it closed two board items tonight and *showed me the records that justified the close* rather than taking my word.

**What cost calls that should have cost one:**
- Learning field shapes by rejection is still real. This project's CLAUDE.md carries a long list of call-shape gotchas — `current_ac` is objects not strings, `dependencies` is an object of slugs not paths, `concept_family` is a string not a boolean, `file_baselines` is server-owned, `research_finding` has no path field at all. **That list exists because the API taught them by refusal.** `knowledge_schema` fixes this going forward and is the right answer; the debt is that a consuming project's operating manual is still the de-facto documentation.
- **No operation to ask "what does this article cost?"** I had to spawn an agent to parse spilled overflow files to answer a size question. `knowledge_stats(id)` returning per-field char counts would have been one call.

**The operation the design obviously wants and does not have:** `knowledge_split`, and after that a `supersede_passage` that keeps prior text retrievable without shipping it in the body.

## 9. The agent roster

**Broadly right, and the constraints produced better results than freedom would have.** The clearest case: the `librarian` is forbidden from authoring knowledge content, and tonight it **refused twice** rather than writing prose — returning me the exact stale sentences in two articles that enumerate the manifest schema and omitted the field this session added. An unconstrained agent would have written something plausible and I would have shipped it. **That refusal is the roster design paying off.**

**Where it cost me a round:** I briefed an `explorer` to re-derive a count that requires headless Blender. Explorers have no Bash. It refused correctly. **The dispatcher knows both the agent's tool list and the prompt; nothing cross-checks them.** A pre-dispatch warning — *"this prompt asks for command execution; `explorer` has no Bash"* — is mechanical and would have saved the round. The store even has a record about this exact failure (`55577e13`), and H20 did not surface it, because H20 matches on subject rather than on the structured mismatch.

## 10. The board and the maintenance queue

**Signal-to-noise on the queue was poor in a specific, measurable direction.** Starting state 46 items, of which **26 were `file_parked`** — informational entries that close at branch merge and can never be drained. **57% of the queue was, by construction, not work.** The `digest` projection labels them, which helps, but they still dominate every count and every "the queue is deep" warning.

**Of the genuinely drainable items, most were already paid**, exactly as the contract warns. Four of the first four `article_missing` items were false by the project's own ruling (gitignored scratch). That is the H10 gap, not a queue gap.

**The queue misled in the direction the skill flags as easy to miss: claiming work was OUTSTANDING when it was not.** It never once claimed a defect was live that was fixed. That asymmetry is worth noting — the queue's failure mode is wasted effort, not shipped bugs.

**A drain provably generates its own tail.** Ours went 36 → 47 during the drain, then 47 → 35. Seven of the eight `reconcile_needed` items in the middle count were created by our own store writes. That is correct behaviour and it is also why the queue never reaches zero.

**The board at 256 items is past auditability**, by the project's own written standard.

## 11. The conductor contract — enforced versus prose

| rule | enforced by | verdict |
|---|---|---|
| tests green before commit | prose only | held tonight because I ran it |
| conductor opens every render | prose only | held; **nothing could check it** |
| capture when the decision is made | **H10** | fired 6×, worked |
| reconcile owning articles | **H7 + disposal gate** | worked, self-amplifying |
| test-writer blind to implementation | **H4** | not exercised |
| agent command allowlist | **H14** | worked (a `gdformat` denial produced correct behaviour) |
| forward-fix, never stack corrections | **prose only, inside the article it governs** | **failed, 57.4%** |
| don't cite a record id in prose | prose only | **failed, 4 records** |

**The highest-value unenforced rule is forward-fixing.** It is stated in the very article that violates it most, it is agreed by everyone, and it has produced the single largest structural problem in this store. §A.7 items 1–2 are the mechanism.

**Second: "the conductor opens every render."** This is the one rule that structurally cannot be delegated and structurally cannot be checked. Tonight it mattered enormously — I refused to rule four plates that an agent's numbers said were fine, and the agent's own follow-up proved the instrument had been hiding its pass condition. **No mechanism exists that could have caught that.** I do not think one can exist, but it is worth naming as a permanent hole rather than pretending the prose rule is coverage.

## 12. What is structurally missing (the design reaches for it and stops short)

1. **`knowledge_split`** — the queue instructs "split it"; no call performs it.
2. **`knowledge_stats(id)`** — per-field sizes; the oversize gate already computes something like it internally.
3. **A slug on `todo`** — everything else has one; board items are the only records that cannot be cited durably.
4. **`measurements[]` on `anti_pattern`** — separate the dated census from the durable lesson.
5. **Ignore-file awareness in `article_missing` / frontier** — `git check-ignore` already exists.

---

## 13. WHAT STERLING DOES NOT DO AT ALL — AND SHOULD

Ranked by damage caused **in this session**, most damaging first. Every entry maps to a real incident.

### 13.1 There is no write-time size or shape feedback on a knowledge record

- **Gap:** nothing tells an author, at the moment of writing, that this write makes a record worse — larger, more stacked, closer to unreadable.
- **Incident:** `mech-part-export` reached 67,568 chars non-history / 101,215 total, of which **57.4% is stacked correction prose**, while carrying its own rule `CORRECT THE FIELD... NEVER STACK A NEW FENCE ON TOP OF AN OLD ONE`. A `capture_owed` item (`a9f30d3c`) is now permanently undrainable because its target article cannot be opened. I personally appended correction blocks to two anti_patterns tonight instead of fixing their fields forward.
- **Fix shape:** the write response already returns `chars_before`/`chars_after`. Add: a warning above a body threshold, and a stronger one when the appended text matches `/CORRECTED|SUPERSEDED|STALE|NO LONGER/` — *"you are stacking a correction; `knowledge_edit(id, field, find, replace)` fixes it forward."*
- **Cost this session:** one undrainable queue item; one reconcile applied to an unread article; one agent dispatched purely to measure what the API could have reported for free.

### 13.2 There is no pre-dispatch check that an agent can do the work it is being asked to do

- **Gap:** the dispatcher holds the agent's tool list and the prompt, and never compares them.
- **Incident:** I briefed an `explorer` to re-derive a count requiring `blender --background --python`. Explorers have no Bash. It refused correctly and returned "NOT re-verified".
- **Fix shape:** a PreToolUse warning on `Agent` — *"prompt requests command execution; `explorer` has no Bash. Consider `debugger` or `general-purpose`."* Keyword match on the prompt against the agent's declared tools.
- **Cost:** one full agent round, and a board item that still carries an unverified count.

### 13.3 There is no way to mark a passage superseded without leaving it in the body

- **Gap:** `knowledge_retire` retires whole records. There is nothing at passage granularity, so "keep the provenance, stop shipping the wrong text" is impossible — you either delete history or you carry both versions forever.
- **Incident:** the 57.4% above is precisely this. Every correction in this project is written by an author who *correctly* refuses to silently delete the wrong claim.
- **Fix shape:** `knowledge_supersede_passage(id, field, find, reason)` — moves the passage into a retrievable `superseded[]` array and removes it from the body. Provenance kept, payload shrunk.
- **Cost:** the largest single contributor to the problem the user asked about.

### 13.4 There is no health surface for the store itself

- **Gap:** no call answers "which records are degrading?" — largest, most-corrected, most-edited, oldest-unverified. `maintenance_query` reports *debt detected by hooks*, not *health*.
- **Incident:** the record that best diagnoses this store's obesity (`4c7a977a` — a staleness warning inside the artefact it warns about is not a control) reached me **by accident**, delivered on an unrelated dispatch at the moment the user happened to ask. Nothing routes store-health knowledge to store-health decisions.
- **Fix shape:** `store_health()` returning the top-N by size, by correction density, by edit frequency, by staleness. It is a query over data the server already holds.
- **Cost:** speculative in part — I am generalising from one lucky delivery. But the three oversize articles reached that state **unobserved**, and that is not speculation.

### 13.5 There is no verification that a rotation note is still true when it is consumed

- **Gap:** the note is written at time T and consumed at T+n. Nothing re-checks it.
- **Incident:** I wrote *"queue 47 → 37 → lower (a librarian is applying two final edits)"*. Those edits landed two minutes later; the count reached 35. I rewrote it manually.
- **Fix shape:** H1 already compares `head_sha` and discloses a moved HEAD. Extend the same idea: re-derive the cheap facts (queue count, board count, tree state) at consumption and show note-versus-now.
- **Cost:** small this time — I caught it. **Flagged as a near-miss rather than a damage report.**

### 13.6 There is no mechanism that distinguishes "the instrument saw nothing" from "there was nothing to see"

- **Gap:** entirely outside Sterling's current scope, and it is the thing that nearly cost the most tonight.
- **Incident:** four render plates came back with no marker. That was equally consistent with "the socket is correct and occluded" and "the probe stopped drawing". Numbers said `PROBE_DONE plates=8 failures=0`. The instrument had been sizing its marker by distance-to-error, so **a perfect result rendered at 5 px** — it hid its own pass condition.
- **Fix shape:** nothing plugin-shaped fixes this. What Sterling *could* do is make the pattern retrievable at the right moment: it already holds `0c94cc59` (an instrument that cannot see your change) and `bfc53113` (ruling under a known render defect), and both reached me late or by luck. A record class for **instrument validity**, delivered when a probe's output is consumed rather than when its source is edited, is the shape.
- **Cost:** I caught it, so zero damage — but only because I refused to rule a blank image. **This is a luck finding and I am naming it as one.**

### 13.7 Honest note on what is NOT here

I found no gap in the record *types*, the retrieval model, or the delivery mechanism's core idea. H20 in particular is very good and I would not change its design, only its inputs. **The problems above are almost entirely about the store's own physical health over time — a dimension the plugin currently has no instruments for at all.**

---

# PART C

## 14. What would have helped, one ordered list

**Cheap and mechanical (would have prevented most of tonight's cost):**
1. Write-time size + correction-stacking advisory on `knowledge_update` / `knowledge_append` *(§13.1)*
2. Ignore-file awareness in `article_missing` and the frontier signal *(retrospective §2.1 — 11 false positives)*
3. Pre-dispatch agent-capability check *(§13.2)*
4. A slug on `todo` records *(§7)*
5. `knowledge_stats(id)` *(§12)*

**Structural — and there are genuinely only three:**
6. `knowledge_supersede_passage` — passage-level supersession *(§13.3)*
7. `knowledge_split` + cold `history[]` *(§A.7, §12)*
8. `store_health()` *(§13.4)*

Items 1 and 6 are the same problem seen from two ends — one prevents new fat, the other removes existing fat. **If only one thing is built, build 1: it is a comparison and a warning string, and it attacks the cause rather than the symptom.**

## 15. Verdict

**Strongest part: H20, and it is not close.** Delivering records matched on the *subject of a dispatch* rather than on files touched is the mechanism that repeatedly put the right warning in front of me before a brief went out to an agent — including one that reversed the direction of a fix, and one that stopped me shipping an unchecked assumption across 38 rows of assets. Nothing else in my toolchain does this. Second place goes to the constraint model: a librarian that **refuses to author** and an explorer that **refuses to guess** produced better outcomes tonight than more capable agents would have.

**Weakest part: the store has no sense of its own physical health.** Records grow monotonically, corrections stack because appending is the cheap and safe path, `history[]` is unbounded, `files[].role` has become a document surface because it is the only path-keyed field, and the only signal any of this generates is a queue item saying "split it" — which no call performs, and which in one case cannot even be opened to action. **The plugin is excellent at capturing knowledge and has no theory of maintaining it.** The user's instinct that this will get worse is correct, and the mechanism is worse than they framed it: growth is proportional to how diligently a project measures and corrects, so **Sterling currently penalises its own best practice.**

**Would I rather work with it than without it? Yes, clearly and not marginally.** Tonight it caught a wrong premise before a fan-out, supplied governance nobody remembered existed, and gave me a durable record of a mistake I made so the next session cannot repeat it. The weaknesses are real and they are all in one area — and that area is fixable with three calls and a warning string.
