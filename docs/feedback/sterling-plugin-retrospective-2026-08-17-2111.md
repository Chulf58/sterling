# Sterling retrospective — 2026-08-17, 21:11 — ONE DEFECT, IN DETAIL

**A focused addendum to `sterling-plugin-retrospective-2026-08-17-2020.md` and
`sterling-plugin-assessment-whole-system-2026-08-17-2020.md`**, written at the user's request after the
session hit a single, clean, expensive failure that neither of those files covers.

**The user's framing, verbatim, and it is the correct diagnosis:**

> *"it was most like in an article already, but it was served to you. write the last sterling plugin retro
> how that should be fixed going forward"*

They are right. The answer existed in the knowledge base. The delivery layer fired, matched on the right
subject, and handed over everything **except** the record that held the answer.

---

## 1. WHAT HAPPENED, WITH RECEIPTS

The user mentioned they already had Mixamo animations. I did not know where. I dispatched a read-only
`explorer` to find them.

**H20 fired on that dispatch — as designed — and its own output names the matched terms:**

> *"STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to dispatch 'explorer'. The store holds records
> matching this prompt's SUBJECT (matched on: already, user, **animation**, **clip**, list, name, different,
> repo, **mixamo**, directory, chulf, users, desktop, directories; central to the record: game,
> **worker_crew**, **animations**, candidate, name, convention, existing, inferred, naming, **clip**,
> **characters**, **animation**, **mixamo**, **clips**, **worker**, standing, tool …)"*

**The subject match was excellent.** `mixamo`, `worker_crew`, `animations`, `clips`, `worker`,
`characters` — it had identified precisely the right territory.

**What it then delivered:** three `anti_pattern` records (inferred asset names, agent tool allowlists,
plate resolution) and five `decision` pointers (worker shelter behaviour, a rig-structure ruling, a
backpack mount, a loop flag, a vendor root-motion ruling).

**What it did not deliver:** the `feature_article` **`worker-animations`** — which, as the returning agent
established, already documented *all* of it:

> *"Yes — completely, and my search was largely redundant with what was already written down… Nothing I
> found is stale or missing from the article."*

That article holds the location (`Animations/` at the repo root, gitignored), the count (6 packs, ~85
FBX), which clips are wired and where (`worker_crew.gd:562`, `worker_clips.gd:60-72`), which were
evaluated and rejected with the measurement (`box walk arc`, 17.7% lateral drift), and the reason the
`AnimationLibrary` is keyed by filename (all 84 raw files share the internal action name
`Armature|mixamo.com|Layer0`).

**Cost of not receiving it:** two explorer rounds, ~165,000 subagent tokens, a wrong-tree sweep of the
Desktop / Downloads / Documents, a project-wide scan of **6,142 `.fbx` files**, a conductor question put
to the user that the store could have answered, and one wrong statement from me — I told the user only
one Mixamo file existed. The user had to correct me: *"i made a folder called animations i think i this
project."*

---

## 2. THE DEFECT, STATED PRECISELY

**The two delivery hooks carve the record space differently, and nothing carries `feature_article` on a
subject match.**

| Hook | Fires on | Delivers |
|---|---|---|
| **H19** | Touching a **path** the store owns (Read/Edit/Write; pointers on Bash) | `feature_article` **+** `anti_pattern` + `decision` |
| **H20** | The **subject** of a dispatch prompt | `anti_pattern` + `decision` — **no `feature_article`** |

**So a feature article is reachable only by touching one of its files.**

That is fine when you are editing code. It fails completely for the class of question where you *do not
yet know which file to touch* — which is exactly the class where the store is most valuable:

- *"Where are the Mixamo animations?"* — the answering article owns `worker_clips.gd` and
  `worker_crew.gd`. I touched neither, because I did not know they were relevant. **That is the whole
  reason I was searching.**
- *"What do we already have for X?"*
- *"Has anyone measured Y?"*
- *"Which clips are wired and which were rejected?"*

**The bitter shape of it: the better the store is, the worse this failure is.** A well-maintained article
concentrates exactly the facts that stop a search from happening — and it is precisely the record type
the subject-axis delivery will not hand you.

⚠ **AND NOTE WHAT DID GET THROUGH.** H20 delivered `5951e214` — *"a kit mesh name INFERRED from a naming
convention fails SILENTLY"* — which is a good, on-topic record that made my brief better. The mechanism is
not broken. **It is filtered to the wrong record types.**

---

## 3. HOW TO FIX IT — CHEAPEST FIRST

### 3.1 Deliver `feature_article` HEADLINES on H20 subject match *(the fix)*

Full articles are large; that is presumably why they are excluded. **Do not deliver the body — deliver the
pointer**, in the same shape H20 already uses for decisions:

```
▸ ARTICLES for this subject (2) — what we already know. Read before searching:
  → worker-animations (active) — the authoritative table of worker clips: what exists,
    what is used, and for what. Owns game/run/worker_clips.gd, worker_crew.gd.
    knowledge_get <id>
  → mech-part-library (built) — …
```

Two or three lines per article. **In this incident that would have replaced two dispatches and a
6,142-file sweep with one `knowledge_get`.** Cost: a few hundred tokens against the 4–8 KB H20 already
spends per dispatch.

### 3.2 Rank articles ABOVE anti-patterns when the prompt is a QUESTION, not a change

An anti-pattern answers *"what will you do wrong"*. An article answers *"what is already true"*. A
dispatch prompt containing *find*, *locate*, *where*, *which*, *how many*, *does X exist* is asking the
second question. **Detect that and lead with the article.** For a prompt that proposes an edit, keep the
present ordering — the hazard is what matters there.

### 3.3 Say what was matched but withheld

If the current design must exclude articles for size, then **say so in the delivery**, one line:

```
(3 feature_articles also matched this subject and were not delivered — knowledge_query types:["feature_article"] …)
```

**A silent omission is indistinguishable from an absence.** I read a rich H20 delivery and concluded the
store had nothing more to say about Mixamo. That inference was reasonable given what I was shown, and it
was wrong.

### 3.4 A `frontier` reply for "not found"

Longer-term, and cheap for a searcher: a call that answers *"is this territory documented?"* without
knowing a path — `knowledge_frontier("mixamo animations") -> {articles: [...], confidence}`. The pieces
already exist; nothing composes them into a pre-search check.

---

## 4. THE PART THAT IS HONESTLY MINE

**The rule already existed and I did not follow it.** This project's conventions say to query the store
on two axes before work — *including exploration, not only edits* — and my own memory index carries the
line *"the `worker-animations` KB article is THE table."*

**The tell I want recorded, because it generalises:** *"where are these files"* **felt** like a filesystem
question, so I routed it to a filesystem search. It was a knowledge question. **The retrieval-first rule
is easiest to skip precisely when the question sounds mechanical**, and that is the moment it pays best.

⚠ **But note the asymmetry, because it is the argument for fixing the hook.** My failure cost two
dispatches on one occasion. **The hook's gap costs this on every occasion, to every future session, and
silently** — the operator never learns the article existed. A rule I break is recoverable; a delivery
layer that structurally cannot surface the right record type is not.

---

## 5. ONE-LINE VERDICT

**H20's subject matching is the best idea in the plugin and it is wired to the wrong half of the store.**
It found the right territory by name — `mixamo`, `worker_crew`, `animations` — and then handed over
hazards and rulings while withholding the one record that held the answer. **Deliver article headlines on
subject match.** It is a few hundred tokens, and in this session alone it was worth two dispatches, a
6,142-file sweep, and a wrong statement to the user.
