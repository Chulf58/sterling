# Sterling plugin retrospective — 2026-08-17

**Project:** dome-farmer (Godot 4.6 + Blender asset pipeline, solo developer, Sterling consumed not developed).
**Session shape:** one long conductor-direct session on branch `feat/asset-pack-swap`. One commit landed
(`c902ce0`), a second slice green and pending. ~14 subagents dispatched. Prior retrospectives exist for
2026-08-14 (×2 plus an addendum) and 2026-08-15 (×2); this is a fresh account, not a revision of those.

**Companion file:** `sterling-plugin-assessment-whole-system-2026-08-17.md` holds the design review.
This file is the session evidence.

---

## 1. WHERE IT GENUINELY HELPED

### 1.1 ⭐ H20 caught a settled user ruling being silently reversed — the single most valuable firing of the session

This is the strongest evidence in the document and it should be read first.

The conductor put a design question to the user: *how do twin-barrelled guns fire?* The user answered
**"DoubleGun alternates, the two Flak fire together"**. H20 then fired as a post-answer audit and named
decision `d86e89de` in its pointer list.

That record, ruled **the previous day**, contains:

> **RULING 5 — FLAK AND GLAUNCHER BOTH ALTERNATE. Chosen: *"Both alternate"*.**

and, in its `alternatives_rejected`:

> **"FLAK / GLAUNCHER — both fire all barrels together"** — *"REJECTED BY THE USER. Heaviest feel, least
> variety, and it would leave no multi-barrel weapon in the game demonstrating alternation except the
> DoubleGun."*

**The user's fresh answer was the previously-rejected option.** Because a user answer is authoritative by
construction, acting on it would have produced two active decisions ruling opposite ways on the same
weapons, with the newer winning on recency, **no test failing and no symptom of any kind**. The conductor
disclosed the record, put it back, and the user re-affirmed the original.

**Nothing else in the stack could have caught this.** Not the suite, not lint, not review. The cost of the
miss would have been a silent design reversal.

⚠ **The caveat that matters for the plugin's authors:** H20's own text says
*"THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask (probed
2026-08-11)."* For the length of one tool call the ruling **had** been reversed. It was recovered only
because the conductor read the audit instead of proceeding. See Part B §12.

### 1.2 The retrieval discipline surfaced a two-week-old error in the store's own content

`225ab7e2` (the weapon-numbers decision) asserted:

> *"STILL NOT RULED, AND STILL MUST NOT BE INVENTED: damage TYPES and armour resistance (neither a
> `damage_type` field nor a per-type resistance map exists in code)"*

An H20 pointer surfaced `212e68dc`, *"Armour is PERCENTAGE resistance PER DAMAGE TYPE — TWO types, kinetic
and thermal"*, **ruled 2026-08-04**. The model and the two types have been settled for two weeks.

The parenthetical was true (nothing is built); the headline was false (it is ruled). **NOT BUILT had been
written down as NOT RULED** — states with opposite consequences: unbuilt work proceeds, unruled work must
stop and ask the user. The wrong claim had propagated into the goal-tracker board item and into a rotation
note. Fixed forward with `knowledge_edit`.

**This is a store-content failure that the store's own delivery caught.** Both halves are worth reporting.

### 1.3 H19 delivered an anti-pattern that predicted a defect before it happened

Dispatching a plate-rendering debugger, H19 surfaced `778dadfd`:

> *"A PLATE PROBE'S IN-FRAME AND PIXEL-COUNT PROOFS CANNOT SEE A REFERENCE MACHINE THAT FAILED TO
> ASSEMBLE — the subject is photographed correctly against a host that silently fell apart, and every
> assertion is true."*

The brief already asked for the buggy chassis **with wheels seated**, and every check in it was about the
chassis. The record's tell — *"every assertion is about the SUBJECT, and none is about the HOST"* —
described the brief exactly. A `SendMessage` correction added host assertions; the agent returned
`WHEELS_REQUESTED=5 SEATED=5 PROMOTED=0`.

**The hook caught a hole in the conductor's own brief, mid-flight.** That is the class of help that
justifies the whole delivery layer.

### 1.4 An agent followed a store record over the conductor's brief, and was right

The conductor wrote *"take each shot's origin from `ring.next()`"* into **three concurrent briefs**,
conflating two different things: where a shot **looks** like it comes from, and where its damage is
**resolved** from. One coder queried the store, found the governing decision, **followed the record and
disclosed the deviation** rather than obeying the brief or silently reconciling.

The correction sent to the other two lanes then found a **real bug**: `ClusterMortar` was computing its
airburst height from `launch.y` — the muzzle's own elevation — so a shell fired from a high tube on an
11-tube rack would break at a different point in its arc than one from a low tube. That is precisely the
range-dependent scatter the user had rejected when declining a timed break.

**Nothing would have failed.** No test covers it; the shells would have burst; the scatter would merely
have looked inconsistent in a way nobody could name.

### 1.5 `maintenance_remove` returning `artifact_evidence` is quietly excellent

Closing a two-day-old `capture_owed` item returned the eleven durable records touching its `file_keys`
since creation — including the anti-pattern written twenty minutes earlier that actually answered it.
**The close was self-justifying.** No other tool in the surface does this and several should.

### 1.6 H3's read-evidence gate refused two edits, correctly, both times

Both refusals were legitimate: the file had changed since the last read (once by another agent, once by
the conductor's own `perl` rewrite). The message names the ledger, the entry count, and the expiry rule.
**No false positives observed this session.**

---

## 2. FRICTION AND WHAT MADE THINGS WORSE

### 2.1 ⚠ H4 + H5 together make blind-authored tests a conductor-only repair job — and the failure is project-wide

The sequence, all in one session:

1. `test-writer` is blocked by **H4** from reading implementation. It must infer the contract. It
   inferred **two wrong signatures** and said so honestly in its report.
2. The wrong signatures produced a **gdUnit4 scan error, exit 105** — which blocks **every suite in the
   project**, not just the new file. 995 tests unrunnable because of one unrun file.
3. A `coder` dispatched to fix the call sites was refused **twice** by `h5-frozen-tests.mjs`:
   > *"'game/test/mech/mech_part_seater_socket_collision_test.gd' is a test path — tests are frozen
   > during the fix loop."*
   The agent correctly refused to route around it via `Write` or `sed`.
4. The conductor did it by hand.

**Every individual hook behaved correctly.** The composition is the problem: H4 guarantees the test will
sometimes be wrong, and H5 guarantees only the conductor can fix it. That combination lands on the
scarcest resource in the session, by design, every time.

⚠ Note H5's own message says *"during the fix loop"* and the error text includes `none toolchain` —
this session was **conductor-direct with no active run**, so the hook's stated precondition did not hold
and it fired anyway. Either the message or the trigger is wrong.

### 2.2 The frontier signal has no ignore-file awareness

H19 fired **STERLING FRONTIER SIGNAL … territory is UNOWNED** on:

```
tools/blender/out/assembled/buggy-disputed-socket/left.png
tools/blender/out/assembled/buggy-disputed-socket/front.png
tools/blender/out/assembled/buggy-disputed-socket/top.png
```

Those are **rendered PNGs in a gitignored directory** (`.gitignore:74`). This project holds ~2,900 of
them. Demanding an owning article for a throwaway render plate is noise, and at scale it would be
overwhelming. **The check needs to consult the repo's ignore rules.** This also appeared in a prior
retrospective, so it has survived at least one round of feedback.

### 2.3 Every `knowledge_query` this session returned a capped window

| Query | `matched_filter` | `cap` | `capped` |
|---|---|---|---|
| decisions+anti_patterns, barrel/socket terms | 693 | 40 | true |
| decisions+anti_patterns, genre/tone terms | 697 | 30 | true |
| decisions, cosmetic/hitscan terms | 458 | 10 | true |
| feature_articles, veskari/breach terms | 76 | 30 | true |

The response note is genuinely well written — it states that `rank_terms` order rather than narrow, and
that a capped window can never establish absence. **But four for four means the practical retrieval
experience in a mature store is "you are always holding a window".** Ranking is doing all the work and
there is no relevance score exposed to tell you whether row 30 was still relevant.

### 2.4 An agent's "I verified it exists" was not "I verified it is correct"

The exporter agent supplied a re-export command citing
`scratchpad/asset-swap/mech-census/socket_census.json` and reported it had confirmed the file exists. It
does exist. **It is the wrong file.** The run crashed immediately:

```
KeyError: 'counts'   at export_part_library.py:3532
```

⚠ **And Blender exited 0.** The wrapper reported success, 288,000 log lines were produced, and the
manifest was untouched. Only grepping the log for `EXPORT_PART_LIBRARY_OK` revealed it.

This is not a Sterling defect, but it is a **Sterling-shaped gap**: the plugin has no notion of "this
command's success is not its exit code", and toolchain entries in `.sterling/config.json` carry a command
prefix with no success predicate. See Part B §12.

### 2.5 H21 fired four times and was right about the trend, wrong about each instance

Every firing named the three permitted exceptions. All four writes were exceptions (two small authored
creates, one live-adjudicated correction, one single-record title fix). **A watch that cannot distinguish
its own exceptions is a counter, not a check** — useful as a session-level trend, noise as a per-call
warning.

---

## 3. WRONG INFORMATION — INCLUDING MINE

**Records that were wrong, and who wrote them:**

| Record | Wrong claim | Reality | Author |
|---|---|---|---|
| `225ab7e2` | damage types "not ruled" | ruled 2026-08-04 (`212e68dc`) | conductor, prior session |
| `5f8a2e8b` | roster table: `minigun 13` parts | `minigun 5`, `machinegun 10` — two different families | conductor, prior session |
| `5f8a2e8b` | fifteen weapon families | sixteen, then seventeen | conductor, prior session |
| `5f8a2e8b` | `DoubleGun → "twin barrel"` | "twin barrel" is a STYLE, not a behaviour; the family had no code at all | conductor, prior session |
| `mech-part-export` | `360 exported, 1 failure` | `361 exported, 0 failures` — already stale before this session | conductor, prior session |
| rotation note + board `5728b586` | exporter admits from "a 40-name set" | it is `vendor_attach_names()`, derived from demo scenes | conductor, prior session |
| **conductor brief, ×3 concurrent** | *"take each shot's origin from `ring.next()`"* | conflated visible origin with hit origin | **this session** |
| **conductor brief** | vendor prefab path one directory short | actually under `Prefabs/Buggies/` | **this session** |

**The `minigun 13` figure is the most instructive.** It matched neither family. One wrong integer made a
ten-part vendor family look already-accounted-for, so a real weapon the player can fit had **no behaviour
code at all** and nothing flagged it. The family count then moved twice in one session — 15 → 16 → 17 —
**with no scope change whatsoever, both moves being counting errors surfacing.**

**A reviewer's finding that was wrong, and whose investigation was still worth it:** an Opus
`reviewer-correctness` pass reported that six weapons build a muzzle ring and never use it, framing the
user's ruling as *"vacuous for six weapons, including the Gatling and the Railgun"*. One `awk` over the
manifest disproved it — all six sit on families with **zero** numbered muzzles. **The same command showed
`DoubleGun` at 20 numbered muzzle keys with nothing consuming them.** A false positive whose verification
produced a true one.

---

## 4. TOO MUCH / TOO LITTLE INFORMATION

**Deliveries large enough to spill to a file, this session:** four.

| Delivery | Size | Used |
|---|---|---|
| H1 session-start conventions + rotation note | 10.2 KB | rotation note: all. Conventions: skimmed — they duplicate CLAUDE.md |
| H19 on `game-design-doc.md` | 14.7 KB | ~5% — it listed **63 decisions** for that path, showing 8, capping the rest |
| H19 on `mech_part_seater.gd` | 19.6 KB | ~15% — 9 hazards, 2 relevant |
| H19 on `docs/mech-asset-inspection-log.md` | 11.8 KB | ~10% |

**The `game-design-doc.md` case is the clearest signal.** Touching the project's spec file delivers a
pointer list of 63 decisions. That is not retrieval; that is the whole store filtered by one path. The
per-path delivery has no notion of *which* part of a large file was touched.

**Where the volume was right:** H20's subject-axis delivery. It fired on prompts rather than paths, its
pointer lists ran 2–5 records, and it produced the session's single most valuable catch. **Small,
targeted, high yield.**

---

## 5. HOOK-BY-HOOK

| Hook | Fired | Verdict |
|---|---|---|
| **H1** (session start / rotation restore) | 1 | ✅ Rotation note restored and consumed cleanly. It carried the exact next slice and its risks; the session started productive in one turn. **Best single mechanism in the plugin.** |
| **H3** (read-evidence gate) | 2 refusals | ✅ Both correct, both after a file changed under me. Message names the ledger and the expiry rule. No false positives. |
| **H4** (test-writer blindness) | continuous | ⚠ Correct in principle, and it did produce honest assertions. But it guarantees contract-guessing; here it cost a project-wide scan error. Needs a signature-supply channel — see Part B §9. |
| **H5** (frozen tests) | 2 refusals | ⚠ Correct refusal, wrong precondition — its message says "during the fix loop" and no run was active. Composes badly with H4. |
| **H7** (reconcile marking) | not observed directly | Not assessable — no run was active. |
| **H10** (capture demand / context pressure) | ~8 | ✅ Mixed but net positive. Capture demands were legitimate every time. `capture_pending` and `no_capture` are the right escape hatches and both were used honestly. The context-pressure notice at 35% and 50% was accurate and actionable. |
| **H14** (subagent command allowlist) | 0 observed | Not exercised visibly — agents' commands were in-policy. |
| **H19** (path-scoped delivery) | ~25 | ⚠ Genuinely useful content, wrong volume. Also fires the frontier signal on gitignored render output. |
| **H20** (subject-axis delivery) | ~10 | ⭐ **The best-designed hook here.** Small payloads, fires where paths cannot reach, caught the session's worst near-miss. Its post-answer timing is the one flaw. |
| **H21** (hand-run article-write watch) | 4 | ⚠ Right about the trend, unable to recognise its own exceptions. |
| **Watchdog tick** | 3 | ✅ The mandatory enumeration (a–e) forced two real dispatches that would otherwise have been skipped at high context pressure. The anti-pattern it cites (`03394c53`) describes exactly the failure it prevents. |
| **NOTHING** | — | ❌ **No mechanism caught that a re-exported library changed 66 assets while a tracked ledger recorded human visual rulings against the old bytes.** The conductor checked by hand. Ruling-invalidation-by-artefact-change has no hook. |
| **NOTHING** | — | ❌ **No mechanism caught `minigun 13`** — a count in a decision matching no real population, hiding a whole vendor family. Numbers in records are never checked against anything. |
| **NOTHING** | — | ❌ **No mechanism noticed a Blender run exiting 0 after an uncaught traceback.** Toolchain entries have no success predicate. |
| **NOTHING** | — | ❌ **No mechanism flagged that a record's TITLE contradicted its own edited body.** `knowledge_edit` has a self-contradiction warning for `knowledge_update`; it did not fire when the statement was rewritten and the title left stale. The conductor caught it by re-reading. |

---

## 6. WHAT I DID NOT EXERCISE

Stated so this is not read as a review of everything:

- **Pipelines / gated runs** — none active. `run_state`, `run_signal`, `run_escalate`, `agent_exit`,
  `handoff_read/write` were untouched. Several agents reported "no run is active" when trying to exit
  through the run surface.
- **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, `/sterling:drain`**
  — not invoked.
- **The TUI dashboard** — not opened.
- **`knowledge_promote`, `knowledge_retire`, `knowledge_link`, `knowledge_preflight`, `concept_designed`,
  `no_capture`** — not called this session (`capture_pending` was, twice).
- **Domain stores** (`~/.sterling/domains/<tag>/`) — no cross-project sharing observed.

---

*Continues in `sterling-plugin-assessment-whole-system-2026-08-17.md`.*
