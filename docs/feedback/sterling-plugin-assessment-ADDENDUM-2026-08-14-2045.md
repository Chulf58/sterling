# Sterling assessment — addendum

**Appends to** `sterling-plugin-assessment-whole-system-2026-08-14.md` and
`sterling-plugin-retrospective-2026-08-14-2030.md`. Everything here was measured **after** those were
written, in the last hour of the same session. One item **changes the top recommendation**.

---

## 1. ⚠ SUPERSESSION HAS A SECOND, WORSE FAILURE MODE — and it is not the one I reported

The main assessment named "superseded records are invisible until fetched individually" as the deepest
flaw, from a case where I **cited** a dead decision. That is the *reader-side* failure.

**There is a writer-side failure, it is silent in a different way, and it destroys settled work.**

`supersedes` is a **whole-record relation**. But records in this store routinely settle SEVERAL things at
once — the titles say so: *"FOUR RULINGS, 2026-08-13…"*, *"HEAVY/WEAPON MOUNTS APPROVED — group 1 of
10…"*, *"THREE USER RULINGS…"*. When a later record supersedes one of those while discussing only ONE of
its rulings, **every other ruling in the superseded record is orphaned.** Not contradicted. Not replaced.
Just quietly no longer served.

**Measured this session:** decision `6d1e8999` recorded three separable user rulings taken from rendered
plates (10 BigRocket parts to a mount; 15 Flak parts assigned by category; one part kept unassigned).
A later decision superseded it while discussing **only the BigRocket mount**. Seven parts that had a
USER RULING lost it and gained no replacement. They went back onto a queue of parts a human must judge
by eye.

**The only observable was a count that grew when it should have shrunk** — 47 → 48 → 54 across three
derivations, during a session whose entire purpose was to shrink it. Both records remained `active` and
individually self-consistent throughout. The surviving Flak ruling survives *only because a human read
both records side by side and said so in a report.* **There is no field, link, or query that records
their disposition.**

### What this changes

The main assessment's top suggestion was *"mark superseded records in every projection"*. That fixes the
reader side only. The full recommendation is now three parts:

1. **Mark supersession in every projection** (unchanged — still first, still cheap).
2. **Make `supersedes` express PARTIAL replacement**, or refuse whole-record supersession when the target
   carries multiple rulings. Even a required free-text `supersedes_scope` field would force the writer to
   name what survives.
3. **Detect the orphan.** When record B supersedes record A, diff their claims; anything A settled that B
   does not mention is an orphan candidate and should be surfaced — as a maintenance item, or in B's own
   write response. **This is automatable and nothing does it.**

### A detection heuristic worth having generally

**A backlog that GROWS after a batch of knowledge work should raise a flag.** In this store, supersession
is the *only* mechanism that can turn settled work back into open work with nobody acting. A count moving
the wrong way is the signature, and it is cheap to watch.

---

## 2. Auto-drain on re-baseline is good behaviour with a confusing surface

Three separate librarians this session reported the same thing: they made a `knowledge_edit` /
`knowledge_update`, then called `maintenance_remove` on the matching queue item, and got back an error —
the item was **already gone**, auto-drained by the write's own re-baseline. One agent's report:

> *"`maintenance_remove` on `5583502c` errored 'no record' — a live `maintenance_query` confirms it is
> already gone; the versioned write auto-drained it."*

**The behaviour is correct** — a real reconcile should close its own item. **The surface is not:** an
agent that did the right thing receives an *error*, and has to reason about whether it succeeded. One
agent spent a paragraph establishing that it had.

**Fix:** `maintenance_remove` on an already-drained item should return success with
`already_drained: true, drained_by: <write id>`, not an error. A no-op that reports the reason is not a
failure.

---

## 3. A drain generates its own tail, and it is worth quantifying rather than warning about

The queue went 45 → 43 → 34 → 22 → 11 → 9 across five passes. **Two of the final nine were created BY the
reconciles performed in the same session** — new `reconcile_needed` items against the very articles that
had just been correctly reconciled, raised because the write touched the article.

The docs warn that "a drain generates part of its own tail". True, and the warning is not enough: it
means a drain can never converge in one pass by construction, and an agent told to "drain the queue"
cannot know whether it is finished.

**Fix:** suppress a `reconcile_needed` raised against an article by that article's OWN reconcile write.
The write is the fulfilment; it should not be its own trigger.

---

## 4. What worked, added: the librarian refusing to guess, twice

Both are worth reporting because they are the agent design behaving *better* than my briefs.

- I briefed *"append a history entry with a full ISO instant"* on a `reference_material`. The librarian
  called `knowledge_schema`, found **that type has no `history` field at all**, and reported the field
  set rather than inventing a place to put it.
- I briefed *"pick the field that is now WRONG and edit it"*. The librarian read the record, found it was
  **silent** on the subject rather than wrong, and refused: `knowledge_edit` needs an anchor that matches
  exactly once, and there was nothing to anchor to. It asked for the anchor instead of widening the match.

**Both refusals were correct and both contradicted the conductor.** `knowledge_edit`'s
match-exactly-once contract is what forced the second one — a looser API would have let it guess. That
constraint is doing real safety work and should not be relaxed.

**Also underdocumented and genuinely good:** `knowledge_edit`'s array-element selector
(`files[path=game/assets/mech_parts/manifest.json].role`). It is the only way to correct one entry in a
long array without retransmitting it, and retransmitting from a token-capped read silently truncates.
This should be prominent in the docs, not discovered.

---

## 5. One more "Nothing" row for the hook table

| Hook | Verdict |
|---|---|
| **⚠ Nothing** | **No mechanism caught a diagnostic that lies after its first execution.** A log line printing `vendor loop_mode=%d before change` was true on the first seat and false on every one after, because it re-read a SHARED resource we had just mutated — so it reported our own override as the vendor's authored value. A decision record cites that exact line as the reason the override is safe to adjudicate rather than escalate to the user. **The justification and the defect were the same line.** No test reads that string; the suite stayed at 908 passing. Found by eye, in passing, while checking something else. |

Generalises past logging: any "remember the original" mechanism that re-reads a shared mutable source has
this shape — a lazily-populated undo buffer, a `previous_value` assigned at write time, a config differ
that reloads rather than snapshotting.

---

## Revised verdict

Unchanged in shape: the type system and delivery-at-use are right, and the plugin caught more of my errors
than it caused.

**But the weakest part is now more precisely located.** It is not "supersession is under-surfaced". It is
that **`supersedes` is a whole-record relation being used to express partial disagreement**, and both of
its failure modes — a dead record read as live, and a live ruling silently orphaned — cost real, shipped,
silently-wrong outcomes in a single session, hours apart, with nothing detecting either.

If one thing is fixed: make supersession express scope, and detect what a supersession drops.
