# Sterling — whole-system assessment, 2026-08-17 evening (20:20)

Companion to `sterling-plugin-retrospective-2026-08-17-2020.md`, which holds the session receipts. This
file assesses the **design**. Every point is grounded in that evidence, but the claims are about the
plugin, not the session.

**Scope I can speak to:** the record type system, identity/versioning, the `knowledge_*` / `board_*` /
`maintenance_*` tool surface, the agent roster, the maintenance queue, and the hook layer.
**Scope I cannot:** pipelines and runs, cleanup, init, merge, council, the TUI, `knowledge_link`. I did
not exercise them and will not review them from their docs.

**One-line verdict up front:** the knowledge model is genuinely good and the delivery layer is the best
thing in the plugin; **the weakest part is that the store has no concept of concurrent writers**, and that
single gap caused or enabled three separate problems today.

---

## 6. THE RECORD TYPE SYSTEM

**The carve is right, and the proof is that the types failed differently.**

`decision`, `anti_pattern`, `research_finding`, `feature_article` and `reference_material` are not five
flavours of note. Today each one failed — or saved me — in a way the others could not:

- The **`anti_pattern`** is the type that earns its existence. Two of them stopped a wrong bulk edit
  (retrospective §1.1). What made them work is `trigger` — a field that describes *the moment you are
  about to make the mistake*, written in the second person. `4cd022bd`'s trigger is *"you only asked where
  the file exists, never where the deletion went"*, and I recognised myself in it instantly. **`trigger`
  is the single best field in the schema.** A `decision` with the same content would not have fired,
  because decisions are indexed by what was settled, not by the shape of the error.

- The **`decision`**'s `alternatives_rejected` did real work twice: once when I needed to know whether a
  question was genuinely open, and once when it stopped me writing a supersede that would have orphaned
  three settled rulings from a plural-titled parent.

- The **`research_finding`**'s two clocks (`source_date`, `capture_date`) plus `volatility_hint` drove
  real triage — two `fast`-flagged findings were closed rather than promoted partly on that basis.

**Would collapsing any two lose something? Yes, and specifically:** `anti_pattern` and `decision` look
mergeable (both are "why things are as they are") and must not be. A decision answers *what did we
choose*; an anti-pattern answers *what will you be about to do wrong*. They are retrieved at different
moments and the second one only works because it is indexed on the mistake.

**Dead weight I observed:** `derived_unconfirmed` and `scope` were never load-bearing in any read I made.
`live_test_refs` is required on `feature_article` and I saw it carry `[]` far more often than a real
`{ac_id, test_paths[]}` — a required field that is usually empty is a field that trains people to fill it
with nothing.

**A structural weakness in `feature_article`:** it is simultaneously the *ownership map* (`files[]`), the
*specification* (`current_ac`), the *state tracker* (`state`, `state_reason`) and the *narrative*
(`what_it_does`, `intended_behavior`). Those age at completely different rates. `files[]` goes stale on
every rename; `current_ac` should be near-immutable; `what_it_does` accretes. Today one article's
`what_it_does` had accumulated **four generations of superseded counts, each fenced with its own
"⚠ SUPERSEDED" preamble quoting the prior wrong figure** — a reader had to parse three nested corrections
to learn one number. The article was honouring its own rule ("every count is current or tagged to a run")
*by accretion*, because there is no mechanism that moves superseded prose into `history` where it belongs.

---

## 7. IDENTITY, VERSIONING AND SUPERSESSION

**This is still the sharpest edge in the system, and the project has fully absorbed the cost.**

Every `knowledge_update` mints a new id. The consuming project's CLAUDE.md now contains, in capitals,
*"RESOLVE EVERY RECORD BY SLUG"*, and this session's own rotation note recorded that one decision *"passed
through FIVE ids in one hour"*. I wrote briefs that deliberately said "resolve by slug, never by an id
written down" — because I had learned that an id in a brief is a time bomb.

**Assessment:** slug-based resolution works and I hit no id failure today. But note what that costs:
**every durable citation in this project's prose, briefs and records is a slug, while the tools return
ids.** Every write echo hands back an id that must not be written down. The API's primary key and the
system's actual identifier are different things, and the gap is papered over by discipline.

**Can a reader tell a live record from a dead one in the surface they actually use?** Partly. `status`
and `superseded_by` exist, but `knowledge_query` results **omit the supersedes chain** (you get
`supersedes_count`), so the cheap surface cannot tell you whether what you are reading has been
superseded in part. Today an agent promoted a finding and correctly noted the original was *"retired as a
tombstone"* — that worked. But `knowledge_promote` retiring the project original is a blunt instrument;
see §8.

**A real supersession failure the design invites:** superseding a *multi-part* record. The store's own
`1cc211b5` documents it — a supersedes link is whole-record while the prose usually replaces only a part,
so the unmentioned rulings become orphans attached to a superseded parent. I hit this today: I needed to
add one family to an enumerated list inside a decision that settled four separate things. **There is no
`amend` operation**, so I created a new decision explicitly titled as an amendment and hand-edited a
pointer into the parent. That worked, and it is a convention I invented, not something the model
supports.

---

## 8. THE TOOL / API SURFACE

**What works well.** `knowledge_edit`'s array-element selector (`files[path=…].role`) is excellent — it
let me fix one stale role inside a 100 KB article without retransmitting an array I had not fully read,
which is precisely the truncation defect `d25f5a9e` documents. `knowledge_append` for `history` is the
right shape. `projection: "digest"` on queries is the difference between seeing the landscape and
drowning. The `{matched_filter, returned, cap, capped}` envelope is genuinely well designed: `capped` is
exact and it is the reason I discovered the queue was 102 and not 60.

**What took N calls that should take one:**

- **Reading a maintenance item's full text.** The digest clips mid-sentence and — for `article_missing` —
  omits the file paths, which are the entire content of the item. That cost a dedicated re-query with
  `projection: "full"`.
- **Finding which items belong to one article.** `maintenance_query` filters on `system_reason`,
  `file_keys` and `contains`, but **not on the owning article slug**, which is how the items are actually
  organised and how any sane drain partitions. Every lane brief had to say "take every item naming one of
  these slugs" and rely on the agent text-matching.
- **Amending an enumerated list inside a decision** (§7).

**Learned by rejection rather than documentation.** The consuming project's CLAUDE.md carries a long
paragraph of field-shape gotchas: `current_ac` is objects not strings; `dependencies` is an object of
slug arrays, not an array; `concept_family` is a string not a boolean; `file_baselines` is server-owned
and refused if passed; `research_finding` has no `title` and no `file_keys` and its `volatility_hint` is a
closed enum where `"low"` is refused; a bare `"2026-07-30"` history date is refused. **That paragraph is
the plugin's documentation debt materialising as a consuming project's maintenance burden.** It even
records that the plugin's own template was wrong about `research_finding` and that the local correction
was ruled to stand. `knowledge_schema(<type>)` exists and is the right answer — the problem is that
nothing points you at it until after a rejection.

**Operations the design obviously wants and does not have:**

1. **A partial promote.** Today four findings had a *portable method half* (e.g. *"ask is-it-in-main, not
   which branch holds a copy"*) wrapped around a local payload of twenty project-specific item ids.
   `knowledge_promote` moves the whole record and retires the original, so promoting exports the noise and
   loses the local content. The agent correctly refused all four and flagged the gap. **The system wants
   `knowledge_extract(id, fields|prose) -> new domain record, origin kept live`** and does not have it.
2. **A config read.** H15 correctly forbids shell access to the store; no MCP call exposes configuration.
   The gate is right and the sanctioned door does not exist.
3. **A dry run.** `maintenance_remove` returns `artifact_evidence` *after* the removal. When I closed six
   verified items it told me, six times, *"no fulfilling artifact-write found… removed on the operator's
   word."* That is exactly the information I wanted **before** deciding.

---

## 9. THE AGENT ROSTER

**The tool lists are mostly right, and the constraints improve output** (retrospective §1.3). Three
specific findings:

- **`librarian` has no `board_*` tools**, which is correct — it drains `maintenance_remove` only. I
  briefed within that and it worked.
- **`test-writer` has no Bash.** Correct for its role, but it means a test author can never see its own
  test run. Today it wrote four cases, could not execute them, and **its fixture turned out to measure
  zeros** — every position read `0.000000`, every `configure()` taking the fallback branch. It could not
  possibly have known. The conductor found it from the suite output. This is a real cost of the
  separation, and the mitigation is not "give it Bash" (that breaks the blindness) but a **conductor-side
  obligation to read the printed values, not just the pass/fail** — which no mechanism enforces.
- **A `debugger`'s Bash cwd is not the repo root and cannot be changed** (retrospective §2.4). Combined
  with H14's literal-prefix allowlist containing `--path game`, this made the project's own toolchain
  unreachable. **`cwd` is an unstated part of the toolchain contract**, and the failure surfaces as a
  permissions error rather than a location error.

---

## 10. THE BOARD AND THE MAINTENANCE QUEUE

**The queue's signal was better than this project's own conventions predict** — about 57% of drainable
items described work genuinely still owed, and the defects found were substantive (a false prohibition, a
count wrong for the third time, a wrong audio-clip attribution, two false deletion claims).

**But the queue has three structural problems, in descending severity:**

1. **It can close an item before the work happens** (retrospective §6). The auto-drain keys on the write,
   not on what changed. Self-concealing, and worst under exactly the parallel drainage a deep queue
   invites.
2. **It duplicates.** 48 `file_parked` items represent ~24 distinct facts, with the same (article, path)
   pair re-fired at four or more distinct timestamps. Duplicates milliseconds apart are documented as an
   over-firing signature; these were hours apart and equally duplicative.
3. **`file_parked` asks the wrong question.** It computes *"does this path exist on some branch"* and
   concludes INFORMATIONAL. The question that decides the verdict is *"which side of the divergence is
   authoritative — has the DELETION merged?"* Two anti-patterns in the store exist solely because the
   mechanism gets this wrong, and one of them caught me. **When the store needs two incident records to
   defend against one detector's phrasing, the detector should change.**

**The board:** 249 items, and one query returned `matched_filter: 191` against `cap: 60`. This project's
own convention says *"a board too large to read is a board nobody will audit"*. That is a
signal-to-noise collapse the tools cannot fix — but nothing in the design pushes back on unbounded growth
either. There is no staleness pressure, no age surfacing, no "this item has been re-verified N times".

**A detector that fired seven times and was right about nothing.** `state_review` on one article compared
its declared `state: planned` against 61,018 bytes of owned code. Six prior reviews all upheld `planned`
after real measurement; the article's own history said *"if a SIXTH state_review fires with no code
change, treat the detector's threshold as the defect."* The seventh fired today.

**The root cause was not the threshold — it was ownership.** The article owned six `game/spike/mps_*.gd`
measurement probes, and in this project every other spike file is owned by a `probes-*` registry article.
It turned out `probes-multiplayer` **already existed and already owned all six** — double ownership since
2026-07-29. The detector was comparing a *feature's* declared state against the byte count of its
*instruments*. Fixing the ownership dissolved it. **The lesson for the plugin: a byte-count-versus-state
detector cannot distinguish an implementation from a test harness, and will reliably produce false
positives in any project that co-locates them.**

---

## 11. THE CONDUCTOR CONTRACT — ENFORCED VS PROSE

| Rule | Enforced by | Reality |
|---|---|---|
| Test author cannot read implementation | **H4** | Held |
| Coder cannot write test files | **H5** | Held (I briefed around it) |
| No shell access to the store | **H15** | Held |
| Agent commands limited to toolchain | **H14** | Held, over-tightly |
| Capture before session end | **H10** | Held — and `capture_pending` is the right escape valve |
| Owning knowledge delivered on touch | **H19 / H20** | Held; H20 is the star |
| Hand-run article writes are exceptional | **H21** | Advisory only, correctly |
| **Conductor runs the gates itself** | **Nothing** | Prose only |
| **Conductor opens every render with its own eyes** | **Nothing** | Prose only |
| **An agent result is evidence, not a verdict** | **Nothing** | Prose only |
| **Two agents must not write one record** | **Nothing** | Prose only — **and it leaked today** |

**The highest-value unenforced rule is "the conductor opens the pictures."** Everything else on that
unenforced list has a partial backstop — a red suite, a contradicting agent. This one has none, and today
it was the *only* thing that found the defect: a procedural recoil that moved every weapon **toward its
own muzzle instead of away**, across three families and two vendor packs, under a **green suite of 1049
cases**. No number in the probe's output was sensitive to the sign; the magnitude was exactly right, the
return-to-rest was exact, the drift was zero. Only the picture was wrong.

I am not proposing a hook that opens images. I am pointing out that the plugin's most load-bearing rule
has no mechanism at all, and that the session where a tired operator skips it will look exactly like a
green one.

---

## 12. WHAT IS STRUCTURALLY MISSING

The user asked specifically for this. Concrete calls and hooks, not wishes. **Ordered by the damage their
absence caused today.**

### 12.1 No concurrency model for records — *the biggest gap*

There is no lock, no lease, no "who is writing what" query, and no advisory warning when a second writer
touches a record another agent touched minutes ago. This single absence caused or enabled three problems:
two agents writing one article (retrospective §2.3), the premature auto-drain (§6), and my inability to
verify partition-disjointness except by hand.

**Concretely wanted:** `knowledge_claim(id_or_slug, agent_id, ttl)` returning a soft lease, plus a
warning in every write receipt of the form *"record touched by agent X 4 minutes ago"*. Even a pure
advisory with no enforcement would have caught all three.

### 12.2 Auto-drain should key on the diff, not the write

Close a `reconcile_needed` item only when the write actually touched the file the item names. Today's
version closed two items nine seconds before their reconcile happened.

### 12.3 `file_parked` should ask the merge question

Replace *"is this path alive on some branch"* with *"is the DELETION an ancestor of the base branch"*.
Two stored anti-patterns exist to defend against the current phrasing.

### 12.4 H19 needs ignore-file awareness

Six guaranteed-useless "territory UNOWNED" firings on gitignored render output. In any project with a
plate or report directory this is permanent noise on exactly the artefacts the conductor must inspect.

### 12.5 A cwd contract for agent Bash

State, verify, or normalise the working directory. A literal-prefix allowlist containing a relative
`--path game` plus an unspecified cwd is unusable, and it fails as a *permissions* error, which sends the
agent down the wrong diagnostic path.

### 12.6 `maintenance_query` should filter by owning article slug

The items are organised by article; the filters are not.

### 12.7 A partial-promotion call (§8.1)

Four findings this session had portable method halves that could not be extracted without exporting local
noise and retiring the local record.

### 12.8 A prohibition-staleness detector

Today's most dangerous stale record was a standing *"⛔ DO NOT RE-EXPORT"* gate, discharged hours earlier
by a commit. Stale prohibitions never cause a wrong answer — they silently prevent correct work, so
nothing ever falsifies them. **A record containing an imperative negative, older than N commits touching
its `file_keys`, is a cheap and highly specific thing to flag.**

### 12.9 A superseded-prose mover

Articles accrete "⚠ SUPERSEDED" fences in `what_it_does` because nothing moves them to `history`. One
article reached four nested generations.

### 12.10 History rotation should warn loudly

An append pushed an article to 21 entries and the server kept the newest 20. The data survives in
superseded versions, but for a record used as an audit trail, silent rotation at a fixed depth is
surprising and it appeared only in a write receipt.

### 12.11 A dry-run for `maintenance_remove` (§8.3)

### 12.12 Nothing detects a self-referential acceptance criterion

Speculative and I flag it as such, but it is the defect that cost the most today. An AC reading *"the
delta aligns with +Z of the captured rest basis"* against an implementation computing
`_back_dir = _rest_basis.orthonormalized().z` is one statement written twice; it can only fail if the
arithmetic breaks, never if the premise is wrong. **A lint that flags an AC sharing a distinctive
identifier with the implementation it tests** would be crude and would have caught this. I do not know
whether it generalises.

---

## 13. WHAT WOULD HAVE HELPED, ORDERED BY VALUE

**Cheap and mechanical (a day each, roughly):**
1. Ignore-file awareness in H19 (§12.4).
2. `maintenance_query` filter by article slug (§12.6).
3. Un-clip `article_missing` digest text so it names its files.
4. Loud history-rotation warning (§12.10).
5. Dry-run flag on `maintenance_remove` (§12.11).
6. Make H1's queue count uncapped, or label it as capped.

**Structural — and there are genuinely only about four:**
1. **A concurrency model for records** (§12.1). Biggest single win.
2. **Diff-aware auto-drain** (§12.2). Fixes a defect that silently destroys the queue's meaning.
3. **A partial-promotion / extraction call** (§12.7). The domain-store idea is under-served without it.
4. **A cwd contract for agent execution** (§12.5).

Everything else on the §12 list is a detector tweak.

---

## 14. VERDICT

**The strongest part is the delivery layer, and specifically H20's subject-axis matching.** It caught an
error that nothing else in the stack could have caught — not git, not the tests, not the queue item's own
text, which actively argued for my mistake. It reached me because it matched on what my *dispatch was
about* rather than on files I had touched, and I had touched none of them. That is a genuinely good idea,
well executed, and it paid for its own considerable token cost several times over in one session.

**The weakest part is that the store has no concept of concurrent writers.** The plugin encourages
parallel agents — the whole conductor contract is built on it — and then offers a write model that
assumes one. Today that produced two agents on one article, and an auto-drain that marked work done nine
seconds before it was done. The second is the more serious: it means **the queue can silently stop being
an inventory of what is owed**, and the failure hides itself in the one surface you would use to detect it.

**Would I rather work with it than without it?** Yes, without hesitation, and the queue drain is the
argument. 102 items, eight parallel lanes, and the store's own records corrected me twice — once before I
damaged eleven articles, once about a number I was about to put to the user as a ruling. The store held
things no test could hold: that a prohibition had been discharged, that a count had been wrong three
times running, that a "not yet wired in" claim was false for 189 of 392 rows. **A codebase cannot tell
you any of that.** The friction is real and most of it is fixable with the six cheap items above; the
value is structural and I would not give it up.

**One closing observation on tone, for whoever reads this upstream:** the most useful records in this
store are the ones written *in the second person about the moment of the mistake*. `trigger` fields that
say "you are about to…" fired correctly today; the same content written as a neutral summary would not
have. That is a documentation-design insight the schema already encodes, and it is worth protecting.
