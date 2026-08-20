# Self-retrospective: conductor session 2026-08-20 (evening) — knowledge_supersede slice, 39-item drain, slug-first surfaces

Conductor-direct session on the self-hosted repo, branch `sterling/feedback-aug-2026-fixes`. Sample: one full TDD slice (`knowledge_supersede`, board 0b33c27b — blind test-writer → coder → opus review → fixer → hardening test-writer), a 39→1 maintenance-queue drain (3 verification explorers + 1 librarian batch), and a second slice (slug-first citation surfaces + dead-slug disclosure, board 2b9f2f1a) in flight at filing time. ~12 agent dispatches. Written by the conductor (Fable session) at the user's request, consolidating two in-session answers verbatim in substance.

## What worked genuinely well

- **The rotation note (H1 restore) is the best single mechanism touched.** Resumed mid-objective after `/clear` with the exact next slice, its constraints (three decision ids), and live risks — zero re-derivation. The note's discipline of carrying only what the store cannot reconstruct is right.
- **The knowledge base paid for itself at design time.** The `knowledge_supersede` design was mostly assembly: 9948475b gave retire's exact semantics and deliberate exclusions, de1a7329 settled slug-vs-id, 01f31039 settled the promotion-review interaction. Three reads and the design space was fenced. `alternatives_rejected` sections have real stopping power — they answer "why not X" before it is asked.
- **The queue's verify-against-HEAD doctrine is correct and measurably so:** 9 of 10 reconcile items in the drain were already-paid. The system honestly frames the queue as detected-not-owed, and closing on verification (no vacuous version bumps) reads as discipline, not bureaucracy.
- **Role separation enforced mechanically, not by promise.** H4 blocked the blind test-writer from reading schemas (it adapted from sibling tests); H5 blocked the fixer-coder from writing test files; H17 blocked a coder from writing bundles. All three agents disclosed instead of routing around. Annoying in the moment, correct in outcome.
- **`knowledge_edit`'s exactly-once refusal with match counts.** A librarian dispatch carrying a wrong conductor-guessed anchor failed loudly with counts; the resume pattern (locate the real anchor in the agent's own context, apply conductor text verbatim) worked cleanly. No blind write ever happened.

## Friction and cost

1. **The oversize article is a standing tax.** `mcp-tool-surface` (~78k chars) cannot be read whole, so anchors for edits cannot be seen before drafting — that caused the librarian's two-round-trip dance. Every legitimate append echoes the same oversize warning and re-queues the same item. Until the split (board 136091d2) lands, every §10 tool change pays this.
2. **Co-tenant drift flags on hub files are high-cost, low-yield.** `tools.ts` and `hooks-full.test.mjs` are owned by 3+ articles each; any touch mints reconcile items for all of them, almost always already-paid (one minted DURING the drain, by a librarian write). If H7 compared diff hunks against an article's declared seam before minting, most would never exist.
3. **No batch maintenance operations.** Closing 26 promotion reviews took 26 `maintenance_remove` calls. The lane piled up because every `reference_material` create auto-mints a review — 25 feedback docs made the lane 69% of queue depth. Batch-close, or a feedback-doc exemption from review minting, would prevent both.
4. **H20 delivery hit rate was low this session** — roughly 2 of 6 injections on-subject (a launcher decision on a supersede-tool dispatch; a TUI repaint anti-pattern on a read-only drain explorer). When it hits it is excellent; the misses cost attention at exactly the moment a brief is being composed. Generic tokens ("test", "full") appear able to carry a match alone.
5. **Board-task premises are unverified prose.** 0b33c27b claimed H20 had "caught a supersede that would have orphaned two rulings" — H20 has no such mechanism; a dispatch had to disprove it before design. The task text's own "verify against HEAD" instruction worked as mitigation but cost a dispatch.

## Present but underperforming

1. **H20's matcher — right channel, weak precision.** Matched on vocabulary, not subject (see friction #4). The matched-on-terms disclosure is honest and speeds dismissal; the discriminating-term floor needs to be stricter about stopword-adjacent vocabulary.
2. **`maintenance_remove`'s artifact-evidence note — right check, uncalibrated message.** Verified-already-paid closes (the documented correct drain outcome) print the same "removed on the operator's word — that is drift" warning as unverified closes. The mechanism cannot distinguish the two, so the warning fires loudest exactly when the rules were followed. A self-asserted `verified_no_drift` flag on the remove would align the audit trail with the doctrine.
3. **`board_remove`'s evidence matching missed the actual artifacts.** Closing 0b33c27b, the evidence list showed one feedback doc from creation time — not the fulfilling decision, article reconcile, or commit. The join is file_keys-based and the fulfilling records' file_keys did not intersect the item's. Matching on the item's objective, or on records citing the item id, would find the real evidence.
4. **The librarian contract handles anchors worse than content.** Apply-verbatim is well-defined for drafted text, but anchored edits into unreadably-large fields need a locate-it-yourself resume half the time. Either the locate-mechanics belong in the standard librarian brief, or a read-side `knowledge_peek(id, field, around)` closes it at the source.
5. **H10's article demand fired mid-slice, not at the boundary.** The demand for a new test file's owner arrived on a Stop while the owning `files[]` append was the next planned action of the same slice. Cheap to satisfy, but the gate treats every Stop as session-end; in flow-through conductor mode most Stops are not. Checking for an in-flight covering dispatch, or deferring to the next dirty-tree commit boundary, would nag at the right moment.
6. **Mint-message accuracy.** The `article_missing` item said "4 file(s)" while its `file_keys[]` carried six. The item text is what verification agents scope by; the mint should derive the count from the array it writes.

## What was missing outright

- **A field-slice read** (`knowledge_peek(id, field, around: "<text>")`) — the read-side twin of the 08-20 assessment's `knowledge_split` ask; would have eliminated the anchor round-trips entirely.
- **Slug alongside id on every surface** — being fixed in-session (board 2b9f2f1a): until then, dispatch prompts had to carry full UUIDs because query digests were the only reliably slug-bearing surface.

## Net

The judgment-preserving mechanisms (rulings with rejected alternatives, refusal-with-remedy writes, verify-before-close) are the strength — they made a two-hour feature land right the first time. The costs concentrate in bookkeeping amplification: oversize articles, co-tenant over-minting, one-at-a-time queue ops, and delivery misses. None made the session fail; each spent attention the mechanism exists to save.
