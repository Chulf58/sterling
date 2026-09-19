# Slice 2 removal map — objective sterling-takeover-2026-09

Scoping output (explorer, sonnet, 2026-09-19) for the cut ruled in decision
`sterling-claude-code-scale-down-boundary` (2ad87dd1). DELETE 17 hook families +
apparatus, KEEP 11. Evidence is path:line from grep; coverage is stated per section.
Sections 6, 7 and parts of 4/8 are INCOMPLETE and need a follow-up read before a coder
deletes anything there. Corrections from the first pass are applied.

## 1. hooks/hooks.json (read whole)

DELETE-list families with live registrations (remove the line): H3:39 · H6-selfcheck:22
(SessionStart) · H8:52 · H9:144 · H13:84,93 · H21:77 · H24:72 · H25:54 · H26:55 · H27:56 ·
H29:117,137 · H30:62 (+66 mcp__codex matcher).
Already unregistered in hooks.json — wired ONLY through agent-template frontmatter (§3):
h4-read-wall, h5-frozen-tests, h6-context-watch, h14-bash-allowlist, h17-bash-write-sweep,
h18-test-write-wall. Pure file deletions once the frontmatter lines go.
KEEP confirmed: H1:21 · H2:30 · H7:92 · H10:145 · H15:46,71 · H16:99 · H19 family
(6-7,17 dispatch-staging; 23,31,40,85,94,110) · H20:53,62,66 (keep, trim the
AskUserQuestion-deny branch) · H22:6,14,57,104,131 · H23:86,111 · H31:123.

## 2. scripts/hooks/lib helpers (33/33 hook files grepped)

KEEP whole: common.mjs, dispatch-residue.mjs, settlement.mjs, transcript.mjs, delivery.mjs,
observed-territory.mjs, undeclared-source.mjs, undeclared-source-scan.mjs, plan-lock.mjs,
plugin-root.mjs (importer h1-session-start.mjs), review-ledger-entry.mjs (importers
h1:28 read-only, h22:52 read+write — see §5).
DELETE whole: contract.mjs (importers h3, h17, h18 — all deleted).
SPLIT: ledger.mjs — h13(DEL) ledgerPath/appendRead/fileHash; h25(DEL)
readLedger/ledgerPath/fileHash; h19-delivery-drain.mjs:10-11(KEEP) ledgerPath/pruneUnhashed
→ keep ledgerPath+pruneUnhashed, drop the rest. advisory-counter.mjs — keep
recordAdvisoryFire (h20/h23). dispatch-advisory.mjs — keep hasUnsuppressedMatch, escapeRe,
extractGlobPrefixCandidates, isReviewerClass (h22); drop isReadOnlyDispatchType (h25/h26
only). dispatch-prompt.mjs — keep extractPathCandidates, parseReviewTerritory
(h19-dispatch-staging, h22); PATH_CANDIDATE_RE used only by h25/h26 (unverified elsewhere).
sanctioned-provenance.mjs — no hook imports it; importers are tests/fixtures
(init-ensure.test, h31-plan-lock.test, h1-plugin-root-sites.test, enforcement.test) and
plugin-root.mjs → DELETE, fix those tests; h31 itself imports only common.mjs+plan-lock.mjs.

## 3. agent-templates (11/11 frontmatter grepped) + registry.json

h6-context-watch.mjs is in ALL 11 templates (2 lines each, Pre+PostToolUse).
h4-read-wall: test-writer.md:21. h5-frozen-tests: coder.md:23, debugger.md:21.
h14-bash-allowlist: coder.md:27, debugger.md:25. h17-bash-write-sweep: coder.md:29,46,55;
debugger.md:27,36,45. h18-test-write-wall: test-writer.md:25.
Templates deleted outright by the decision: coder, test-writer, implementation-architect,
reviewer-correctness/-performance/-security/-skeptic; debugger as a CLASS. Survivors:
librarian, researcher; explorer → becomes `scout` (rename/repurpose — a design call, not
resolved here); an `implementor` template is NEW (owns change + tests). registry.json:
pipeline class = 9 entries, conductor_direct = librarian, debugger. Chain (article
agent-distribution 3882375a): registry.json.class → AGENT_CLASS (packages/schemas/src/
records.ts, exact lines unread) → PIPELINE_AGENT_TYPES → H8 (deleted). Other readers of
AGENT_CLASS: packages/tui/src/main.ts and state.ts (display) → adjust, not delete.

## 4. Staged pipeline surface (partial)

packages/mcp-server/src/server.ts tool list: run_state:622, agent_exit:631, run_signal:647,
run_escalate:689, handoff_write:724, handoff_read:733 → unregister all six.
tools.ts implementations: agent_exit ~10453-10520, run_signal ~10520-10606 (CAS
transition casTransitionMerge at 10572), run_escalate 10606+, handoff_write 10711+,
run_state ~10401 (registration not pinned). brain.ts (state machine) and runtime.ts: exist,
unread. scripts/dispose-run.mjs (237 lines), consume-exit.mjs (106), prep.mjs (218):
pipeline-only by name, internals unread. skills/: grill-plan, grill-intent, council,
planning exist (feature/ does NOT) → delete all four.
KEPT code that still branches on an active run: h10-direct-capture.mjs:186
`if (store.getRun()) allow()`; h16-event-register.mjs:17 `if (run) allow()`;
h1-session-start.mjs:1803,1808 (pipeline-dispatch prose in a string); h7-file-touch.mjs
(comment only). board_query lane_advisory (tools.ts:8469+) has no run dependency — keep.

## 5. Review ledger / merge gate

review-ledger-entry.mjs importers (13 files): scripts/review-ledger.mjs (DELETE),
scripts/lib/review-trailers.mjs (DELETE — only used by direct-merge's trailer block),
scripts/commit-reviewed.mjs (DELETE), scripts/direct-merge.mjs:25, h22:52, h1:28, 6 tests.
h1 uses classifyLedgerEntry+readLedger read-only (lines 341-435). h22 READS AND WRITES
(742-754: withLedgerLock → readLedger → writeLedger) dispatch-receipt entries → after the
cut h22 is the only writer; verify h1's classifyLedgerEntry copes with h22-only shapes.
scripts/direct-merge.mjs: DELETE the trailer/receipt refusal block ~494-666
(Reviewed-By-Agent check ~557-622, Review-Receipt binding ~629-666); KEEP dirty-tree
refusal 68-71, reconcile/article-debt refusal 96-425, settlement mint 231-352,
board-payment/parked sweep 741-822. Where commit-reviewed.mjs is invoked from
(a skill?) was not traced.

## 6. Tests — INCOMPLETE (filename matching only; ~25 of 198 scripts/tests seen, 0 of 64+
mcp-server test files opened)

DELETE whole by name: h3-failclosed-boundary.test.mjs; h25-h26-advisory-precision,
h25-test-authoring-lint, h27-dispatch-signatures, h29-codex-consult-failure; the 16 h17-*
files (baseline-integrity-redo, concurrent-mutation-unattested, secure-io-slice1/2,
ancestor-hardening, b-baseline-list, b-detect-and-deny, b-surface-survives-a-sweep,
b-taint-latch, backslash-non-injectivity, baseline-ancestor, baseline-symlink, bounded-io,
percall-attribution, percall-baseline, pre-state-snapshot, stamp-honor-hardening);
check-failclosed-boundary(.test|-hardening.test); merge-review-receipts(.test|-hardening);
review-ledger-legacy-handle; commit-reviewed-bytes-v2-malformed.
TRIM (owner survives): h22-receipt-expiry, h22-ledger-v2-entry, h1-receipt-remedy-wording,
review-ledger-entry-owner (KEEP), hooks-full.test.mjs (titles not enumerated),
enforcement.test.mjs (H14 assertions at ~793), h14-git-ro-grant.test.mjs (DELETE).
mcp-server: brain.test.ts, runtime.test.ts and every run_*/handoff test → unread.

## 7. npm run check arms (0 of 10 scripts opened — inference)

check-agent-registry ADJUST (4-agent roster) · check-totality DELETE with brain.ts ·
check-spawn-contracts ADJUST · check-agent-prompts ADJUST · check-tool-grants ADJUST
(run_*/handoff_* grants go) · check-skills ADJUST (4 skills gone) · check-bundles-fresh KEEP
(verify it does not import sanctioned-provenance) · check-failclosed-boundary DELETE ·
check-record-citations KEEP · check-projection-fresh KEEP · check-stale-claims KEEP.

## 8. config keys (config.ts 140-199 read; the rest located by grep only)

caps (141-149: inner_loop_n, outer_loop_m, research_resume_per_phase,
dispatch_per_agent_type, phase_death_cap) → DELETE (pipeline + H8; readers untraced).
context_watch (151-168): SPLIT — keep `conductor.{soft_pct,hard_pct}` (H10 gauge) and
`windows` (H10 denominator — correction: the gauge needs it); delete warn_pct/block_pct/mode
(H6 only). dispatch_register (189-193) KEEP (H22). store_guard:378 (allow_scripts — dead
after the H15 rebuild) DELETE. review_ledger:517 DELETE with the ledger scripts (h22 still
writes entries — check stale_days reader). reviewer_selection, difficulty, article_demand
(253), session_events: unread; article_demand/session_events likely H10 → keep.

## 9. KEEP-side breakage risks, ranked

1. HIGH h10:186 and h16:17 `if (run) allow()` — remove the branches, not just leave dead.
2. HIGH h22 writes ledger entries commit-reviewed.mjs used to co-write; confirm h1's
   classifier handles h22-only entries, or drop the H1 receipt block too.
3. MEDIUM H20 AskUserQuestion deny: function/lines not located — coder must find the
   exit-2 pre-ask branch in h20-mechanism-axis.mjs and route it to the warn-only path.
4. MEDIUM AGENT_CLASS mirror in packages/schemas/src/records.ts + TUI readers must change
   in the SAME commit as registry.json (article agent-distribution AC6 totality test).
5. LOW check-bundles-fresh.mjs vs sanctioned-provenance import — one read to confirm.

## Follow-ups before a coder deletes

Two or three focused read-only dispatches: (a) tests — enumerate hooks-full.test.mjs
titles and the mcp-server run/handoff/brain tests; (b) pipeline surface — read brain.ts,
runtime.ts, dispose-run/consume-exit/prep and the six tool bodies; (c) config readers for
the six unread blocks and the 10 check scripts.
