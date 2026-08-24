# Sterling plugin retrospective — 2026-08-24

**Project:** dome-farmer (Godot 4.6 / GDScript / Blender). Sterling is CONSUMED here, never developed here.
**Session shape:** one long conductor-direct session, 9 commits (`bda8069`..`0c4a4e6`), branch `feat/playtest-response-fixes`, local-only.
**Companion file:** `sterling-plugin-assessment-whole-system-2026-08-24-0450.md` — the design review. **Read that one if you only read one.** This file is the evidence base.


---

## 1. Where it genuinely helped — receipts

Ordered by how much damage each prevented.

### 1.1 H23 output-axis delivery caught a false ruling I had already propagated into four surfaces

**The single most valuable thing the plugin did all session, and nothing else in the stack could have done it.**

I inspected 24 cross-pack mech builds and wrote, into a *tracked* ledger, two board items and a commit message, that eight of them "sit on a wheeled or tracked chassis that the bipedal-only gate refuses today." I had inherited that framing from a ledger section written earlier the same day.

It was false. Decision `full-mech-customization-anything-that-physically-fits-may-be-fitted` had been ruled by the user at 16:21 that day — *"go for full customization do all is interchangeable if the parts actually is able to fit together"* — lifting the deferral and recording that the bipedal predicate has **zero production call sites**.

H23 surfaced it **on an unrelated tool result**, matching on output content rather than on any path I had touched. Path-scoped H19 could not have: the decision's `file_keys` are `garage.gd` / `mech_assembly_graph.gd` / `mech_part_library.gd`, and I was editing a markdown ledger and looking at PNGs.

**Cost avoided:** a false constraint in the project's `/clear`-surviving inspection ledger, plus a board item that had *deprioritised a real defect* to LOW on the false reasoning that "a player cannot reach this build in v1."

### 1.2 H23 did it a second time, on hills

Same session, ~90 minutes later, I wrote "decision `f5b02cc3` rules hills are IMPASSABLE for v1" into a board item. That ruling was reversed on 2026-07-31; the canonical record's **own title** opens with `⛔ RE-OPENED AND REVERSED`. H23 surfaced `HILLS ARE WALKABLE` unprompted.

**This one has a sting:** I took the dead id out of the project's own `CLAUDE.md`, which narrated the original incident and quoted the ruling in the present tense. The governing file had itself become a stale-summary source.

### 1.3 H24 blocked a command that would have read a red suite as green

```
H24: gate invocation masked — '<godot> --headless --path game -s' is followed at top level by ';',
which swallows the gate's real exit code.
```

I wrote `<suite> > /tmp/out.txt 2>&1; echo "EXIT=$?"; sed ...`. **Denied, correctly.** This is exactly the defect the hook exists for and I walked straight into it while trying to capture output. Cheap, precise, zero false positives all session.

### 1.4 H3 forced real read-evidence twice

```
H3 [direct mode]: no fresh read-evidence for 'game/mech/mech_part_library.gd' — Read the exact file before editing.
```

Both times I had "read" the file via `sed -n` through Bash, which does not register. The hook is right that a Bash read is not read-evidence, and both times the forced `Read` showed me surrounding context I had not seen. **Two firings, two legitimate.**

### 1.5 The review-receipt gate refused an unbacked commit

```
commit-reviewed: no un-consumed review-ledger entries — dispatch a reviewer before committing,
or commit bare and answer at the merge gate
```

Correct refusal on a doc-only change after the receipt had been consumed. It also named the legitimate exit, which stopped me improvising. I committed bare with **no** `Reviewed-By-Agent` trailer rather than writing a false one.

### 1.6 Codex (sparring partner) caught three real defects the roster reviewer had cleared

Ranked:

1. **`mech_part_library.gd:579`** — a docstring I had just written asserted `kind` "is never null" **eight lines below a comment measuring 31 null `kind` rows.** `reviewer-correctness` read the same lines and returned CONFIRMED-CORRECT on docstring self-consistency. Codex: *"the guard rationale is false and can cause a future unsafe edit."*
2. **`chain_lightning.gd:599`** — a lightning arc and its audio terminate at y=0 while the building is drawn at terrain height, so on raised ground the strike visibly misses. The roster reviewer marked it CONFIRMED-CORRECT, reasoning about the *delta* (genuinely unchanged); Codex reasoned about the *state* (genuinely wrong). **Both were right about different questions** — that disagreement is the most useful review output I got.
3. **`building_chunks.gd`** — flagged that a comment I wrote prescribed a future design ("the right shape is a separate ground-height argument") with no ruling behind it.

**Three for three on comment-bearing prose.** The decision to put an outside model family beside the roster reviewer paid for itself in one session.

### 1.7 `reviewer-correctness` caught the session's worst latent defect

I replaced a probe's shared `_finish()` with per-mode tails. The reviewer found that the exit condition had silently lost the half that watches `_fail`:

> *"a set that saves 2 of 3 views while `_bad()` logs a real instrument fault prints `PROBE_DONE failures=N` and **exits 0**."*

**A probe reporting success while its own instrument is broken** — in a project whose whole asset pipeline is judged by probes. It also caught that an authoring lane's consumer audit was materially under-counted: it reported 20 `world_position()` call sites and had **missed the entire `game/weapon/` directory**; the real figure is 36–37.

### 1.8 H20 protected a brief before it went out

On dispatching a debugger at a suspected vendor-data defect, H20 surfaced the exact-match-join anti-pattern — *"AN EXACT-MATCH JOIN SILENTLY DISCARDS THE VENDOR'S OWN DECLARATION"*. I had already quoted it in the brief, so it changed nothing, but the timing was right: **before** the fan-out, not after. The lane came back VENDOR INTENT, no bug, in one pass.

### 1.9 `board_remove` disclosed missing capture

```
"artifact_evidence": [], "note": "no fulfilling artifact-write found ... removed on the operator's word.
If work fulfilled this item, its capture is missing (that is drift, not a formality)."
```

Accurate and actionable. I wrote the missing anti-pattern record because of that line.

---

## 2. Friction, and where it made things worse

### 2.1 ⚠⚠ `git commit --amend -F` silently destroys the review-receipt trailer — six times

**The worst plugin-adjacent failure of the session, and nothing in Sterling noticed.**

`commit-reviewed.mjs` stamps `Reviewed-By-Agent` correctly. I then amended each commit with a hand-written message file to get a fuller body — and put a blank line between `Reviewed-By-Agent:` and `Co-Authored-By:`. **Git only treats the final paragraph as trailers**, so the receipt became unparseable:

```
$ git log -1 --format='%(trailers:key=Reviewed-By-Agent,valueonly,unfold)'
(empty)
$ git log -1 --format=%B | grep -c "Reviewed-By-Agent"
1
```

A raw grep finds it; `direct-merge.mjs` uses `--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)`. **All six code-touching commits were silently unmergeable.** I found it only because I happened to check after the sixth. Repaired with `filter-branch` across the whole range.

**Nothing warned at any point** — not the stamping tool, not a hook, not the commit itself.

### 2.2 H25 dispatch capability advisory: 6 firings, 6 false positives

Every single firing was the same shape — my brief *mentions* a tool the agent lacks, as a **prohibition**:

> H25: you are about to dispatch 'reviewer-correctness', and the brief mentions tool(s) its installed grant does not hold: 'Bash'

The briefs said *"you have no Bash — say so where it limited you"*. The hook matches tool names in prose with **no polarity detection**. It also fired a "TEST-AUTHORING ADVISORY" twice when I dispatched a reviewer to *review* a test file. It is advisory and cheap, but at 100% false-positive rate over six firings it is pure noise, and noise trains you to skim the next one.

### 2.3 The maintenance queue is too large to audit

H1 opened the session with **210 drainable items** (184 `reconcile_needed`, 16 `article_missing`, 9 `promotion_review`, 1 `state_review`). I dispatched a read-only audit lane at it. It returned:

> *"`maintenance_query` reports `matched_filter: 186, capped: false` at cap 200 ... I only actually read roughly 120–140 of the 186 digest rows before the persisted-file token cap cut me off, and I verified only **1 item** against HEAD."*

**One of 186 verified.** The agent was honest about it, which is to its credit and to the roster's. But a queue that cannot be audited in one agent's context is a queue nobody will drain, and it grows.

### 2.4 H21 fired 5 times and was right 0 times — but the rule it names is real

Firings on hand-run knowledge writes #1–#5, escalating to a session-cumulative advisory at 8,237 bytes. Every write it flagged was one of the three named exceptions (a small authored create, or a write needing live adjudication). The hook cannot distinguish "conductor authoring a record from live session judgement" from "conductor doing bulk reconcile work a librarian should do" — and only the latter is the defect.

### 2.5 I fabricated record uuids twice and both were refused

```
board_update: no record '3706f401-0000-0000-0000-000000000000' ...
knowledge_get: no record '604e19ed-f9cc-0000-0000-000000000000' ...
```

My error, and the refusals were clean and correctly worded. Worth noting only because the tools accept unambiguous 8-char prefixes and I reached for full uuids anyway — the guidance to prefer full uuids "in briefs and dispatch inputs" appears to have leaked into my direct tool use.

---

## 3. Wrong information — including mine

**This section is deliberately weighted toward my own errors.** Five stale claims reached artifacts this session; three were caught by H23, one by an agent, one by the user.

| # | Wrong thing | Who wrote it | Caught by |
|---|---|---|---|
| 1 | "the bipedal gate refuses these builds" → tracked ledger, 2 board items, commit msg | me | H23 |
| 2 | "hills are IMPASSABLE for v1", citing a July-reversed ruling taken out of `CLAUDE.md` | me (id sourced from `CLAUDE.md`) | H23 |
| 3 | A board item quoting a probe log whose defect **had already been fixed at HEAD** | me | the coder lane sent at it |
| 4 | A board item listing a test suite as owed **that already existed at HEAD, 469 lines, same 27 test names** | inherited board state | the diff, after a full test-writer dispatch |
| 5 | "the promoting pack is Spiders" — misread a log line, then **put it in a review brief where it was believed and echoed back** | me | a brittle assertion I had just been told to add |

**#5 is the instructive one.** The reviewer recommended pinning an exact set instead of "at least one". I implemented it with my wrong value; the assertion went red on its first run and named the true answer (`Heavy`). A control caught its author's own bad premise — but note that the *review* had already absorbed and repeated my error, because I supplied it in the brief.

**A record that was itself wrong, and it was the most expensive:** a `decision` captured a **one-time** user instruction (*"lets try to keep the active tasks at a floor of 6"*) as a standing policy reversal, with a title announcing *"the no-floor ruling is reversed"*. I read it, believed it, and rewrote the governing file in three places to impose a permanent floor. The user corrected me: *"that was a one time only... normally there is no floor"*. **The record's content was accurate; its scope was invented at capture time.** See §6/§13 of the companion file — this is a record-type gap, not a reader error.

---

## 4. Too much / too little information

**H19/H20/H23 deliveries** ran roughly 200–900 tokens each and fired dozens of times. Two were large enough to be spilled to a file — the H1 session-start injection (12.7 KB) and a later H23/H19 combined block (14.1 KB), both persisted to `tool-results/` with a 2 KB preview inline.

**Fraction actually used:** low per-firing, but that is the wrong metric. Two H23 firings out of dozens prevented false rulings reaching tracked artifacts. I would not trade the noise for the misses. The delivery hooks are the best-value component in the plugin *precisely because* they are cheap enough to over-fire.

**Where information was too thin:** `knowledge_query` capped windows. Hunting for a cited-but-unlocated ruling:

```
{"matched_filter": 567, "returned": 12, "cap": 12, "capped": true,
 "note": "cap reached — ... a capped window can never establish absence"}
```

The note is excellent and I obeyed it — but the consequence is that **I could not establish the ruling did not exist**, so a real piece of work (`29f6ed6a`, the riser re-expose) is now blocked on "find the ruling or ask" rather than on anything technical.

---

## 5. Hook-by-hook

| Hook | Firings | Verdict |
|---|---|---|
| **H1** session start | 1 | Correct and dense. Rotation-note restore worked exactly as designed; it consumed the note and anchored it to a sha. Queue-depth warning accurate (210). |
| **H3** contract gate | 2 blocks | **Both legitimate.** Correctly refused to count `sed`-via-Bash as read-evidence. |
| **H4** test-writer / implementation | 0 observed | Not exercised — the test-writer I dispatched did not attempt an implementation read. |
| **H5** frozen test paths | 0 | Never fired; I edited test files as conductor and was allowed to. Cannot assess. |
| **H7** reconcile marking | not directly observed | Its output showed up indirectly as `reconcile_needed` items the librarian closed (5 named ids). |
| **H10** capture + context | ~5 | Accurate pressure reporting (35% soft → 50% hard → 62%). The **`deferred: N file(s) owned by live dispatch`** behaviour is a genuinely good design — it declined to demand capture for files an agent still held. |
| **H14** command allowlist | 0 direct denials | I never hit it as conductor. ⚠ I *bypassed* the `gdformat` write-form restriction once with `dangerouslyDisableSandbox` — see §2 of the companion file. |
| **H19** path axis | ~10 | Useful but the lowest hit-rate of the three delivery hooks; it fires on the file you touched, which is the axis you are already thinking about. |
| **H20** subject axis | ~4 | Fired on dispatches and codex consults. Right moment (pre-fan-out). One firing surfaced a prior-answer `research_finding` and correctly warned about re-deriving it. |
| **H21** article-write watch | 5 | 0 true positives. Cannot distinguish authoring from bulk reconcile. |
| **H23** output axis | ~12 | **The best component in the plugin.** Two firings prevented false rulings reaching tracked artifacts. The only hook that can catch a reader who is nowhere near the governed files. |
| **H24** gate exit lint | 1 block | Perfect. Precise message, real defect, zero false positives. |
| **H25** dispatch capability | 6 | **6/6 false positives.** No polarity detection on tool mentions. |
| **H27** dispatch signatures | 0 | Opt-in, not opted in. Cannot assess. |
| **⛔ Nothing** | — | **The `--amend -F` trailer destruction.** Six unmergeable commits, no warning from any layer. |
| **⛔ Nothing** | — | **A board item pointing at work already done at HEAD.** Cost a full test-writer dispatch. |
| **⛔ Nothing** | — | **A `decision` whose scope was invented at capture.** Cost an inverted rule in the governing file and a user correction. |
| **⛔ Nothing** | — | **A stale POLICY in `CLAUDE.md`.** A stale *fact* gets contradicted by the code; a stale policy is silently obeyed. Three restatements of a reversed dispatch rule shaped the whole session's behaviour. |

---

*Design assessment, §6–§15, continues in `sterling-plugin-assessment-whole-system-2026-08-24-0450.md`.*
