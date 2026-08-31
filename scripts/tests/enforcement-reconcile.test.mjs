// H17 (B) SURFACE — THE RECONCILIATION CLEARER (Sterling de-complication S4).
//
// Spec: decision `b-baseline-hash-list-concrete-design` (fe861066) — THE
// CONCRETE DESIGN for the persistent (B) baseline hash list this file pins
// against: file location/shape, clearer-only minting, VERIFY-or-ADOPT modes,
// absent/malformed semantics, and the (A)/(B) latch-domain split. fe861066
// settles the concrete mechanism for decision
// `h17-demotes-to-tripwire-with-minimal-b-hash-list` (78dc9bd6) — H17 demotes
// from security boundary to TRIPWIRE; the enforcement STAMP/attestation
// apparatus (including scripts/enforcement-stamp.mjs) is DELETED outright, and
// this persistent hash LIST is its replacement comparator input. Decision
// `the-clearer-is-a-tripwire-not-a-boundary-and-the-all-tool-latch-gate-is-
// what-makes-its-precondition-true` (0ac7be95) supplies the R-clauses this
// file must keep pinned across the rework: R1 (no sequence of userspace
// observations establishes an immutable instant — the accepted residual),
// R3 (per-directory-EDGE binding — retained directories are not rebound to
// the live namespace unless every edge is re-checked at the LAST position),
// R4 (WINDOWS REFUSES RATHER THAN DEGRADES), R5 (unpinned-guard findings — a
// guard that is live but has no test regresses silently), R6 (the pre-unlink
// confirmation must stay synchronous), R7 (the enumeration/size bounds).
//
// THIS FILE PINS ONLY THE CLEARER. It does not repeat the latch SET/READ pins
// already established in scripts/tests/h17-b-taint-latch.test.mjs (S3) — this
// file assumes that mechanism exists and reuses its fixture idiom (the latch
// path, the (B) path set) to construct fixtures the clearer must react to
// correctly.
//
// ===========================================================================
// NAMED RESIDUAL — READ THIS BEFORE RE-LITIGATING IT AS AN OVERSIGHT.
//
// THE ACCEPTED RESIDUAL IS THE WIDE ONE, NOT THE NARROW ONE. Decision
// `the-clearer-is-a-tripwire-not-a-boundary-and-the-all-tool-latch-gate-is-
// what-makes-its-precondition-true` (0ac7be95) R2 CONSCIOUSLY WIDENED it "from
// 'a process that can rerun the procedure' to ANY PROCESS CAPABLE OF CONCURRENT
// MODIFICATION" of the protected surface, its manifest, or their directory
// namespaces; decision
// `ship-the-taint-clearer-alone-the-all-tool-gate-is-admission-control-not-
// quiescence` (4b3183b8) R4 keeps that widened form as the SHIPPED guarantee
// ("0ac7be95 R1 holds unchanged, and the residual stays consciously widened to
// 'ANY PROCESS CAPABLE OF CONCURRENT MODIFICATION'").
//
// WHY THE NARROWER WORDING THIS BLOCK USED TO CARRY — "bypass requires a
// prepared surviving process that reproduces the conductor-only gate" — WAS
// CHECKED AND REFUTED, which is the justification and travels with the ruling:
// WRITE CAPABILITY AND INVOCATION CAPABILITY ARE DISTINCT. A confined or
// already-running helper that holds an INHERITED WRITABLE DESCRIPTOR to a leaf
// (or a narrowly brokered "save this file" capability) can rewrite that leaf
// after its final hash and yet CANNOT spawn Node, import this module, call the
// conductor-only operation, or forge `callerRole`. And ACCIDENTAL CONCURRENT
// WRITERS raise the identical correctness problem with no adversary at all. The
// narrow wording was the conductor's own motivated attempt to retire a live
// finding into an already-accepted caveat; it is recorded as an ERROR in
// 0ac7be95 R2, not quietly edited away.
//
// SO: this suite does NOT defend against a concurrent modifier, and cannot.
// 0ac7be95 R1: NO SEQUENCE OF USERSPACE OBSERVATIONS ESTABLISHES AN IMMUTABLE
// GLOBAL INSTANT — leaf A can be rewritten in place while B..N are checked, and
// again between the last check and the `unlinkSync`, with no JavaScript
// scheduling point required. What THIS slice buys is TRIPWIRE ECONOMICS AND A
// CHECKED CLEARANCE, not a boundary: the surface is proven to MATCH ITS BASELINE AT
// THE MOMENT OF CHECKING, with evidence bound through retained descriptors and
// per-directory-edge identity so that PERSISTENT NAMESPACE SUBSTITUTION cannot
// pass (AC-R30..AC-R34, AC-R49). Quiescence is NOT supplied here: 4b3183b8 R1
// rules that the all-tool latch gate is ADMISSION CONTROL, NOT QUIESCENCE — it
// stops new roster-agent tool calls from BEGINNING, and cannot revoke an
// already-approved call, stop a surviving child, or constrain another session —
// and 4b3183b8 ships this clearer ALONE, without that gate.
//
// Do not read the absence of a "concurrent writer" test in this file as a gap
// nobody noticed, and do not narrow this paragraph back.
// ===========================================================================
//
// Authored BLIND to any implementation of the clearer (there is none yet, and
// the pre-rework implementation this repair pass supersedes is not read
// either) and to scripts/hooks/h17-bash-write-sweep.mjs, per H4 — no hook or
// CLI source was read to write these pins. Every expectation comes from the
// decision prose cited above (a decision record is spec, not implementation —
// H4's wall gates Read/Grep on code, not knowledge_get/board_get).
//
// ===========================================================================
// THE ENTRY POINT — UNDECIDED IN THE BRIEF, SO THIS FILE DECIDES IT AND THE
// IMPLEMENTER BINDS TO IT (fe861066 prefers a conductor-only MCP operation
// over a CLI; this file cannot invoke a running MCP server without Bash, so it
// pins the CORE reconciliation logic as a single importable async function
// that an MCP tool wrapper — or, if that direction changes, a CLI — calls
// into). VERIFY is the default MODE; ADOPT is reached by the explicit `adopt`
// flag, per fe861066 D5:
//
//   scripts/enforcement-reconcile.mjs
//     export async function reconcileEnforcementTaint({
//       cwd,                        // required: project root
//       callerRole,                 // REQUIRED, and FAIL-CLOSED. See "THE
//                                   // IDENTITY GATE" below — this REPLACES
//                                   // the original absent-means-conductor
//                                   // convention, which failed OPEN. Applies
//                                   // in BOTH modes (fe861066 D5: "ADOPT ...
//                                   // conductor-gated").
//       callerAgentId = null,       // present/truthy => an AGENT is calling
//                                   // and the call is refused REGARDLESS of
//                                   // callerRole. AC-R10 pins this.
//       adopt = false,              // TRUE selects ADOPT MODE (fe861066 D5).
//                                   // No latch -> mint the baseline list from
//                                   // current (B) surface, report
//                                   // initialization, create no latch, remove
//                                   // nothing (AC-R53). Latch present -> mint
//                                   // + atomically install the list, RE-OPEN
//                                   // and re-verify the installed file, then
//                                   // run the SAME bound-evidence
//                                   // reconfirmation VERIFY uses before
//                                   // removing the latch LAST (AC-R54/AC-R55).
//                                   // FALSE (default) selects VERIFY: read the
//                                   // existing list, verifyExactManifest
//                                   // against current, any delta refuses, NO
//                                   // list present refuses (AC-R2).
//       _testHookAfterEnumeration,  // TEST-ONLY. If provided, awaited exactly
//                                   // once, after the baseline list has been
//                                   // read and the current (B) set has been
//                                   // enumerated+hashed and a verification
//                                   // verdict computed, but strictly BEFORE
//                                   // any mutation (latch removal, or in ADOPT
//                                   // mode the list write) is attempted.
//                                   // Production callers (the MCP tool) MUST
//                                   // NEVER pass this. It exists solely so
//                                   // this file can inject a deterministic
//                                   // TOCTOU race instead of guessing at
//                                   // timing.
//       _testHookBeforeRemoval,     // TEST-ONLY. See "SEAM 2" below.
//       _testHookBeforeDirectoryOpen, // TEST-ONLY. See "SEAM 3" below.
//       _testHookBeforeConfirm,     // TEST-ONLY. See "SEAM 4" below. It is the
//                                   // ONLY point from which the evidence
//                                   // binding's properties (b), (c) and (d)
//                                   // and the R3 directory-edge rebinding can
//                                   // be pinned AT ALL.
//                                   //
//       _testHookInsideConfirm,     // TEST-ONLY. See "SEAM 4b" below. Fires
//                                   // INSIDE confirmBoundEvidence, AFTER the
//                                   // first-position root/edge check and
//                                   // BEFORE the (a)-(d) content proofs.
//                                   // CALLED, NOT AWAITED — a thenable return
//                                   // REFUSES, so every hook this file passes
//                                   // to it is a plain sync arrow.
//       _testForcePlatform,         // TEST-ONLY. 'win32' forces the win32 arm;
//                                   // the module ORs it with the real
//                                   // platform (REAL_WIN32 || FORCED), so
//                                   // forcing a non-win32 value is a NO-OP and
//                                   // can never degrade a real Windows host.
//                                   // AC-R35/AC-R36 pin R4 through it.
//     }) => Promise<{
//       cleared: boolean,           // VERIFY: true iff the latch was removed
//                                   // THIS call. ADOPT with no latch: always
//                                   // false (nothing existed to clear) even
//                                   // though the list was minted — AC-R53.
//                                   // ADOPT with a latch: true iff the latch
//                                   // was removed THIS call, same as VERIFY.
//       reason: string,             // human-readable; never thrown away. In
//                                   // ADOPT-with-no-latch this is fe861066's
//                                   // own quoted phrase, "baseline
//                                   // initialized; no latch removed"
//                                   // (AC-R53). When the (A) tracked
//                                   // enforcement surface is dirty, ADOPT
//                                   // still proceeds but the dirt is named
//                                   // LOUDLY in this string (AC-R57).
//     }>
//
// THE BASELINE LIST ITSELF (fe861066 D1) — the module's ONLY comparator input
// now that the enforcement stamp is deleted:
//   .sterling/enforcement-baseline.json   (gitignored; NOT under transient/ —
//     persistent evidence does not belong in a lifecycle-bound directory)
//   { version: 1,                          // EXACTLY 1; any other value or
//                                          // absence is malformed (AC-R3)
//     minted_at: <ISO string>,             // DIAGNOSTIC ONLY. Never freshness
//                                          // or authority — an ancient
//                                          // minted_at with an exact (B)
//                                          // match still verifies (AC-R58)
//     entries: [ { path, sha256 }, ... ] } // SORTED ARRAY, strictly ascending
//                                          // by path (ties/dupes are
//                                          // malformed, AC-R3); path is
//                                          // repo-relative POSIX, sha256 is
//                                          // lowercase 64-hex
// covering BASELINE_GLOBS = ['.claude/agents/**', '.sterling/config.json',
// '.claude/settings*.json'] — a fixed surface definition; membership under it
// is dynamic (this file's makeGitProject() fixture matches exactly the three
// paths CODER_REL/SETTINGS_REL/CONFIG_REL below).
//
// THE (A)/(B) LATCH DOMAIN (fe861066 D5, LATCH DOMAIN clause) — the ONE latch
// spans BOTH a (A) tracked-git-surface incident and a (B) baseline-list
// incident. Default VERIFY must ALSO prove the (A) tracked enforcement
// surface clean (git-visible enforcement paths unmodified since HEAD) and
// refuse when it is dirty EVEN IF the (B) list matches exactly (AC-R56).
// ADOPT is the explicitly-named human-acceptance operation: it proceeds
// despite (A) dirt, but must report it LOUDLY in `reason` (AC-R57).
//
// (A)'S SCOPE IS SETTLED, NOT THIS FILE'S INTERPRETATION: git-reported dirt on
// `hooks/**` UNION the shared `ENFORCEMENT_SURFACE` export
// (`scripts/hooks/lib/contract.mjs:31` — `['.claude/settings*.json',
// '.claude/agents/**', '.sterling/config.json']`, the same glob set as
// BASELINE_GLOBS above). AC-R56/AC-R57's fixture dirties a tracked
// `hooks/some-file.mjs` — squarely inside `hooks/**` — and AC-R56 additionally
// pins the NEGATIVE: a tracked file OUTSIDE both `hooks/**` and
// ENFORCEMENT_SURFACE (this file uses `.claude/CLAUDE.md`, which matches
// neither glob) may be dirty while (B) matches exactly and VERIFY still
// CLEARS — (A) is scoped to this union, not to "any repo dirt", because a
// clearer that refused on any dirty working tree would be unusable mid-branch.
//
// ===========================================================================
// THE IDENTITY GATE — INVERTED (S4r repair pass, conductor ruling). EXACT
// CONTRACT; the implementer binds to this rather than inventing a shape.
//
//   callerRole: 'conductor'   // the ONLY value that permits a clear
//
//   * THE CALLER MUST MAKE AN EXPLICIT POSITIVE CONDUCTOR ASSERTION. The call
//     clears ONLY IF `callerRole === 'conductor'` (exact string, case-
//     sensitive) AND `callerAgentId` is absent/null/empty.
//   * EVERY other shape REFUSES, including — and especially — `callerRole`
//     being OMITTED, `undefined`, `null`, `''`, or any other string. ABSENCE
//     IS NOT EVIDENCE OF CONDUCTOR.
//   * A truthy `callerAgentId` refuses even when `callerRole === 'conductor'`
//     (an agent asserting conductorhood while its own identity is on the
//     payload is the spoof this belt-and-braces rule exists for). AC-R10.
//
//   WHY THE ORIGINAL DEFAULT WAS THE HIGHEST-SEVERITY DEFECT IN THIS MODULE:
//   absent-agent_id-means-conductor mirrors H17's hook convention, where the
//   payload is produced by the PLATFORM and absence is genuinely meaningful.
//   Here there is no MCP wrapper and no production caller in the repo yet, so
//   every clearance path runs with the argument simply ABSENT — and any future
//   wrapper that forgets to thread `agent_id`, or receives `undefined` from a
//   hook payload, silently grants every agent the clear. The entire protocol's
//   security rests on this one argument, because a baseline matching current disk
//   is otherwise sufficient to clear. A fail-open default on the single gate
//   that makes the mechanism a gate at all is not a default, it is the bypass.
//   AC-R24 pins the inversion directly; every other test in this file now
//   passes the assertion explicitly via the CONDUCTOR constant, which is
//   itself part of the pin — if the implementation keeps failing open, AC-R24
//   is the only test that notices, and it must.
//
// ===========================================================================
// SEAM 2 — `_testHookBeforeRemoval`. EXACT CONTRACT (bind to this; do not
// guess). REQUIRED BY AC-R18 / AC-R19.
//
//   type BeforeRemoval = () => void | Promise<void>
//
//   * If (and only if) the caller supplies it, it is AWAITED EXACTLY ONCE.
//   * It fires AFTER the FINAL verification verdict is settled — i.e. after
//     the last re-read of the baseline, the last re-enumeration/re-hash of the
//     (B) surface, and after the decision "this call is entitled to remove the
//     latch" has been reached — and STRICTLY BEFORE the first syscall of the
//     latch-removal walk (before any open/stat/unlink aimed at the latch).
//     `_testHookAfterEnumeration` fires BEFORE the final pass; this one fires
//     AFTER it. They are different points and neither substitutes for the
//     other.
//   * It is awaited on the ENTITLED path only. On a path that has already
//     decided to refuse, it need not fire (no test depends on that), but if it
//     does fire the tests below still hold.
//   * A throw from the hook propagates (the tests never throw from it).
//   * Production callers (the MCP tool wrapper / any CLI) MUST NEVER pass it.
//
//   WHY IT MUST EXIST — the CRITICAL this suite could not previously see: the
//   module releases every pin and descriptor taken during verification before
//   it starts a fresh removal walk, and `removeLatch()` re-validates only the
//   LATCH's own identity. Nothing binds the BASELINE or the (B) SURFACE across
//   that interval, so an attacker who wins the window can substitute a
//   TAMPERED surface together with a MATCHING attacker baseline — self-consistent,
//   so a naive "just verify once more" fix does not see it — and the call
//   still returns cleared:true. AC-R19 is that exploit. Closing it requires the
//   verdict to be BOUND to the exact bytes/identities it was computed from
//   (e.g. carry the baseline's own content hash + each (B) leaf's dev/ino/size/
//   mtime/hash from the verdict into the removal step and re-confirm them, or
//   hold the descriptors open across the removal), not merely repeating a
//   self-consistency check.
//
// SEAM 3 — `_testHookBeforeDirectoryOpen`. EXACT CONTRACT. REQUIRED BY AC-R21.
//
//   type BeforeDirectoryOpen = (relPosixPath: string) => void | Promise<void>
//
//   * If (and only if) the caller supplies it, it is AWAITED IMMEDIATELY
//     BEFORE the (B) enumeration walk opens/enumerates a directory that it
//     discovered as an entry of a parent directory (i.e. every directory below
//     a (B) root; the roots themselves may or may not fire it — no test
//     depends on the roots).
//   * It receives the repo-relative, forward-slash path of the directory that
//     is about to be opened (path invariant: never an absolute or backslash
//     path).
//   * It may fire more than once per call (once per discovered directory, per
//     enumeration pass). Tests must be written to tolerate that.
//   * Production callers MUST NEVER pass it.
//
//   WHY IT MUST EXIST: a directory returned by `readdirSync` that VANISHES
//   before the walk opens it is currently swallowed and enumerated as EMPTY,
//   so a populated `.claude/agents/**` subdirectory can be renamed out across
//   both enumeration passes and restored afterwards, and the surviving visible
//   set matches the baseline exactly. AC-R20 pins the same guard's
//   permission-denied face WITHOUT any new seam; AC-R21 pins the ENOENT face,
//   which is not deterministically constructible without this seam.
//
// SEAM 4 — `_testHookBeforeConfirm`. EXACT CONTRACT. REQUIRED BY AC-R25..R28,
// AC-R30..R34, AC-R37, AC-R46 and AC-R47. Each of those tests asserts THE SEAM
// FIRED FIRST, so a seam that is missing (or silently dropped by the
// destructuring) is diagnosed as a missing seam rather than read as an
// accidental pass.
//
//   type BeforeConfirm = (confirmBoundEvidence: Function) => void | Promise<void>
//
//   * If (and only if) the caller supplies it, it is AWAITED EXACTLY ONCE, on
//     the ENTITLED path, INSIDE the removal step: AFTER THE LAST VERIFICATION
//     OF ANY KIND — after the second re-read/re-enumeration pass, after
//     `.sterling` is pinned, after the latch's kind + dev/ino have been
//     re-confirmed — and IMMEDIATELY BEFORE the pre-unlink bound confirmation.
//     NOTHING but that confirmation and the `unlinkSync` follows it.
//   * It receives THE EXACT FUNCTION VALUE that will be invoked as the
//     pre-unlink bound confirmation (the `beforeUnlink` callback). AC-R37
//     inspects that value and nothing else.
//   * Production callers (the MCP tool wrapper / any CLI) MUST NEVER pass it.
//
//   WHY IT MUST EXIST — WITHOUT IT, THREE OF THE FOUR BINDING PROPERTIES AND
//   THE WHOLE R3 EDGE REBINDING ARE UNPINNABLE. Decision 0ac7be95 R5 records an
//   independent mutation pass: of the four properties the clearer rests on,
//   ONLY (a) — re-hashing the retained descriptor — was pinned by any test.
//   Stripping (b) rename-substitution via `lstat` through the retained parent,
//   (c) directory-membership re-listing, or (d) the baseline's own bound
//   confirmation EACH LEFT THE SUITE 24/24 GREEN.
//
//   SEAM 2 vs SEAM 4 — SETTLED BY THE CODER, NOT BY THE ARTICLE. The owning
//   article's sequence prose puts `_testHookBeforeRemoval` BEFORE the second
//   re-read/re-enumeration pass; THAT PROSE IS STALE. The code fires SEAM 2
//   AFTER the second verification pass, exactly as SEAM 2's contract above
//   states. So SEAM 2 and SEAM 4 are ADJACENT WINDOWS, both after the last
//   verification, differing only in whether the latch has already been
//   re-classified. A binding tamper injected at either is caught by the bound
//   confirmation and by nothing else — which is why the two authoring lanes
//   produced DUPLICATE pins rather than one hollow set and one live set, and
//   why the merged sequence keeps ONE pin per property instead of two.
//
//   SEAM 2 IS STILL THE RIGHT SEAM FOR EXACTLY ONE PIN: AC-R29, the latch's own
//   dev/ino re-confirmation. The latch is re-classified AFTER SEAM 2 and BEFORE
//   SEAM 4, so a swap injected at SEAM 4 would be past the guard under test and
//   would only be re-testing 0ac7be95 R1's unfixable residual.
//
// SEAM 4b — `_testHookInsideConfirm`. EXACT CONTRACT. THIS IS THE SEAM THAT
// DISCRIMINATES, and it is what makes the R3 pins (AC-R30..AC-R34) worth
// anything at all.
//
//   type InsideConfirm = () => void   // CALLED, NOT AWAITED. A THENABLE RETURN
//                                     // REFUSES — every hook here is a plain
//                                     // synchronous arrow returning undefined.
//
//   * It fires INSIDE `confirmBoundEvidence`, AFTER the FIRST-POSITION
//     `confirmBoundRoots` / `confirmBoundEdges` and BEFORE the (a)-(d) content
//     proofs. It fires exactly once, on the entitled path.
//   * Production callers MUST NEVER pass it.
//
//   WHY IT IS THE ONLY HONEST WINDOW FOR TWO DIFFERENT CLASSES OF PIN:
//     - A DIRECTORY/ROOT/ABSENCE tamper injected at SEAM 2 or SEAM 4 is caught
//       by the FIRST-position root/edge check, so such a pin proves only that
//       SOME position of that check exists — it cannot see the loss of the
//       LAST-position re-check, which is the one whose absence reopens the
//       original attack in one move. Injected HERE, the first position has
//       already run and ONLY the last-position re-check can refuse. AC-R30..R34
//       therefore use this seam, and their sabotage is "comment out the
//       LAST-position confirmBoundRoots/confirmBoundEdges, leaving the first".
//     - A LEAF/MEMBER/BASELINE tamper injected here is past the root/edge check
//       entirely, so ONLY the (a)-(d) content proof named by the pin can see
//       it. AC-R26..R28 and AC-R46/R47 therefore use this seam too: it removes
//       the root/edge check from the set of possible causes.
//
// SEAM 5 — `_testForcePlatform`. EXACT CONTRACT. REQUIRED BY AC-R35/AC-R36.
//
//   Decision 0ac7be95 R4 rules that WINDOWS REFUSES RATHER THAN DEGRADES: the
//   win32 arm has no parent binding and would fall back to a path-addressed
//   re-read, retaining the original TOCTOU and permitting path substitution
//   between checks. Against the standing Windows/Linux parity requirement (most
//   Sterling users are Windows users) a silently weaker Windows guarantee is
//   not acceptable, so the safe win32 behaviour is to REFUSE RECONCILIATION AND
//   LEAVE THE LATCH PRESENT.
//
//   * The module ORs the forced value with the real platform
//     (`REAL_WIN32 || FORCED_WIN32`), so ONLY 'win32' has any effect and
//     forcing a non-win32 value is a NO-OP. THE SEAM CANNOT DEGRADE A REAL
//     WINDOWS HOST INTO THE POSIX ARM — that direction is the one that would
//     matter, and it is closed by construction rather than by convention.
//   * All platform-arm sites route through ONE accessor, so AC-R36's named
//     sabotage really is a single edit with no second layer behind it.
//   * Production callers MUST NEVER pass it.
//
//   AC-R35 is AC-R36's control and forces a NON-win32 value against AC-R1's
//   proven-clearing fixture, so a refusal in AC-R36 cannot be explained by
//   "supplying the seam denies". On a genuine win32 host AC-R36 runs its
//   NATURAL arm with NO SEAM AT ALL — a pin for what Windows does must, on
//   Windows, exercise Windows and not a simulation of it.
//
// ===========================================================================
// THE REASON VOCABULARY CONTRACT — READ BEFORE IMPLEMENTING.
//
// The repair pass that produced this file was ordered by an independent
// mutation verifier's finding: THREE DIFFERENT REFUSAL CONDITIONS ALL RETURNED
// {cleared:false} WITH NO DISCRIMINATED REASON, so no test could tell which
// guard fired, and at least one pin (AC-R15) was provably HOLLOW — its named
// sabotage left the suite green because the call simply fell into a DIFFERENT
// refusal path that satisfied both of its assertions. `reason` is therefore
// now part of the contract, not a debug string. Every refusal must be
// ATTRIBUTABLE to the guard that produced it, in wording a DELIBERATE guard
// emits rather than a raw errno leaking out of a catch-all (a verdict carried
// by `unlinkSync` failing with EISDIR is exactly the accident these pins
// exist to forbid).
//
// The families below are asserted by the tests via the REASON table. Where a
// test asserts a family MUST NOT appear, the two families are the ones a
// reader could otherwise confuse — that negative is the whole point of the
// pin, so widening one family's wording until it swallows its sibling
// re-opens the hollowness.
//
//   no-latch no-op      "no latch present — nothing to clear (no-op)"
//   latch unreadable    "the latch file could not be read (unreadable) — an
//                        unreadable latch is not an absent one"   [NOT no-op]
//   latch bad shape     "the latch path is not a regular file (abnormal
//                        shape: directory | symlink)"
//   mid-flight swap     "the latch changed between verification and removal
//                        (mid-flight swap)"                 [NOT bad-shape]
//   changed mid-flight  "the (B) surface / baseline CHANGED DURING VERIFICATION"
//                                                        [NOT plain mismatch]
//   baseline absent        "no baseline present — nothing to verify against"
//   baseline malformed     "the baseline is malformed / unparseable JSON, or
//                           fails shape validation (bad version, unsorted or
//                           duplicate entries, bad hash format)"
//   baseline incomplete    "no baseline entry for <path> (unattested)"
//   baseline hash mismatch "hash mismatch for <path>"
//   baseline stale entry   "<path> is attested by the baseline but no longer exists"
//   enumeration failed  "could not enumerate <dir>"
//   directory vanished  "<dir> vanished during enumeration"
//   caller gate         "conductor-only: an agent caller is not authorized"
//   no conductor claim  "no explicit conductor assertion (callerRole) — an
//                        unidentified caller is not a conductor"  [NOT the
//                        agent-caller wording, NOT any baseline family]
//   removal failed      "the latch could not be removed (unlink denied)"
//
// NEW FAMILIES (S4r mutation-repair pass, decision 0ac7be95 R3–R7). Each names
// a guard that is LIVE-BUT-UNPINNED or NOT-YET-BUILT; the wording is what makes
// the pin attributable rather than satisfiable by an accidental catch-all:
//
//   leaf substituted    "<path> was substituted after the verdict (the retained
//                        descriptor no longer matches the live name)"  — (b)
//   membership changed  "<dir>'s members changed after the verdict (<name>
//                        appeared)"                                    — (c)
//   baseline rebound       "the baseline changed after the verdict"          — (d)
//   dir substituted     "<dir> was substituted after the verdict (the retained
//                        directory is no longer the one the live path
//                        reaches)"                                     — R3
//   expected absence    "<path> was absent at verification and has appeared"
//                                                                      — R3
//   platform refusal    "reconciliation is not supported on win32 — refusing
//                        rather than degrading to a path-addressed re-read;
//                        the latch is left in place"                   — R4
//   bound exceeded      "<what> exceeds the <n> limit"                 — R7
//
// NEW FAMILIES (S4 baseline-list rework, decision fe861066). The list replaces
// the deleted enforcement stamp as the sole comparator input:
//
//   bad version         "the baseline version is not 1 / is missing"
//   entries unsorted    "the baseline entries are not sorted / out of order"
//   bad hash format      "the baseline hash for <path> is not a valid
//                        lowercase 64-hex sha256"
//   adopt initialized   "baseline initialized; no latch removed" — fe861066's
//                        OWN quoted wording (D2 BOOTSTRAP), asserted VERBATIM
//                        by AC-R53, not merely by family
//   tracked surface dirty "the tracked (A) enforcement surface has changed
//                        since HEAD" — fe861066 D5 LATCH DOMAIN; refuses under
//                        VERIFY even with an exact (B) match (AC-R56), and is
//                        reported (not refused) under ADOPT (AC-R57)
//
// EVERY BOUND REFUSAL MUST NAME THE BOUND. R7 records that the test file
// contained NO assertion whatsoever about any of the six/seven bounds; an
// oversized fixture also breaks the exact-manifest match, so a bound test that
// asserts only `cleared:false` is HOLLOW BY CONSTRUCTION — the manifest guard
// satisfies it with every bound deleted. The bound-family wording is the only
// thing that distinguishes "refused because a bound fired" from "refused
// because the oversized fixture is unattested".
//
// A refusal message may of course carry extra diagnostics (errno, path); the
// pins require the DELIBERATE wording to be present, and in the named pairs
// require the sibling's wording to be ABSENT.
//
// RETURN-CONTRACT ASSUMPTION THIS FILE MAKES, STATED SO THE IMPLEMENTER CAN
// CORRECT IT RATHER THAN GUESS AT WHAT THESE TESTS WANT: every EXPECTED
// refusal path (baseline absent/malformed/incomplete/duplicated/non-exact/
// changed-during-verification/wrong-caller/latch-absent/latch-abnormal-shape)
// resolves to {cleared:false, reason} rather than throwing/rejecting. A
// genuinely unexpected internal error (e.g. the removal syscall itself fails
// after a clean verification) may reject; this file's one test for that case
// (AC-R17) accepts EITHER a resolved {cleared:false} or a rejection, because
// "fails loudly" (item 5 of the task brief) is satisfied by either shape — the
// invariant under test there is the DURABLE EFFECT (latch survives), not the
// calling convention.
//
// HARNESS is a faithful, non-imported copy of the makeGitProject/lane/git/
// oneLine/baselinePath/writeBaseline/coderPath/sha256Of/latchPath idiom from
// scripts/tests/h17-b-taint-latch.test.mjs (copied in shape, not imported,
// since that file exports nothing). The SYMLINK_SKIP/UNREADABLE_SKIP/
// DIR_WRITE_DENY_SKIP host-capability-probe idiom is likewise copied in shape
// from that file (itself copied from scripts/tests/h17-baseline-symlink.test.mjs
// for SYMLINK_SKIP).
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/enforcement-reconcile.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
  lstatSync,
  statSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

// Dynamic import in `before()` mirrors the existing SterlingStore-import idiom
// this repo's H17 test files already use, so a missing or unparseable module
// surfaces as a clear, single failure point rather than a bare top-level throw.
// (It was written when the module did not yet exist; it stays because the
// diagnostic is the same either way.)
let reconcileEnforcementTaint;
before(async () => {
  const mod = await import(pathToFileURL(join(root, 'scripts', 'enforcement-reconcile.mjs')).href);
  reconcileEnforcementTaint = mod.reconcileEnforcementTaint;
});

function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function reasonOf(result) {
  return oneLine(result && result.reason);
}

// THE EXPLICIT POSITIVE CONDUCTOR ASSERTION (see THE IDENTITY GATE in the
// header). Spread into every call that is entitled to reach the verification
// logic at all. It is deliberately a named constant and not a literal repeated
// 20 times: the shape is a CONTRACT, and AC-R24 pins that omitting it refuses.
const CONDUCTOR = { callerRole: 'conductor' };

// The discriminated refusal families (see THE REASON VOCABULARY CONTRACT in
// the header). These are the whole point of the repair pass: without them a
// test cannot tell WHICH guard produced {cleared:false}, and a pin that cannot
// name its own guard is satisfiable by any sibling refusal — which is exactly
// how AC-R15 and AC-R16 were measured HOLLOW.
const REASON = {
  baseline: /baseline/i,
  malformed: /malformed|unparse|invalid json|parse error|not valid json/i,
  incomplete: /incomplete|unattested|not attested|no baseline entry|missing (a )?baseline entry/i,
  hashMismatch: /hash mismatch|hash does not match|bytes do not match|differs from the baseline/i,
  duplicate: /duplicat|more than one (baseline )?entry|repeated entry/i,
  staleEntry: /no longer exists|not present on disk|stale (baseline )?entry|attested .* (is )?absent|missing from the current/i,
  // The TOCTOU family. Deliberately does NOT include the plain-mismatch
  // wording: a second pass that merely reports "hash mismatch" has not proven
  // it detected a CHANGE, only that the surface disagrees with the baseline.
  changed: /changed during verification|changed between verification and removal|changed (after|since) the (final )?verdict|changed mid-?flight/i,
  // The sibling AC-R8/AC-R52/AC-R19 must NOT resolve to.
  ordinaryMismatch: /\bmismatch\b|does not match the baseline|\bunattested\b|\bincomplete\b|\bduplicate\b/i,
  callerGate: /conductor|agent|authoriz|not permitted/i,
  // The FAIL-CLOSED half of the identity gate: an OMITTED conductor assertion
  // must refuse in wording that names the omission, distinctly from AC-R10's
  // "an agent presented itself" refusal.
  missingConductorAssertion: /no (explicit )?conductor (assertion|claim)|callerRole|caller role|conductor assertion (is )?(missing|absent|required)|unidentified caller|caller (identity|role) (is )?(missing|absent|not (declared|asserted|supplied))/i,
  noLatch: /\bno-?op\b|\bno latch\b|\bnothing to (do|clear)\b|latch (is )?absent|absent latch|no latch (is )?present/i,
  // Wording only a deliberate SHAPE check emits. Note what is NOT here: raw
  // errno text ("EISDIR: illegal operation on a directory, unlink") — the
  // verifier measured AC-R13 staying green with both shape guards stripped,
  // because unlinkSync's own EISDIR was silently carrying the verdict.
  latchAbnormalShape: /not a regular file|abnormal (latch )?shape/i,
  latchUnreadable: /unreadab|could not be (read|opened)|EACCES/i,
  midFlightSwap: /swap|mid-?flight|between verification and removal|no longer the (same|one)/i,
  enumerationFailed: /could not enumerate|unable to enumerate|enumeration failed|unreadable director|unenumerable/i,
  directoryVanished: /vanish|disappear|no longer exists|removed during enumeration/i,
  removalFailed: /remov|unlink|permission|EACCES|EPERM/i,

  // ---- NEW FAMILIES (S4r mutation-repair pass; decision 0ac7be95 R3–R7).
  // Deliberately GENEROUS alternations. These guards are the ones the mutation
  // pass found live-but-unpinned or not-yet-built, so the load-bearing
  // assertion in each new pin below is the DURABLE EFFECT (`cleared !== true`
  // and the latch surviving), which goes red under the named one-line sabotage
  // regardless of wording. The reason assertions are the SECOND line of
  // defence: they exclude the accidental-catch class that made AC-R16 hollow
  // (a TypeError swallowed by the outer catch into a correct-looking refusal),
  // because an accidental catch cannot name the offending PATH. Every new pin
  // therefore asserts the offending path by name as well as its family.
  substituted: /substitut|replac|renam|rebound|no longer (the )?(same|one)|no longer (resolves|reaches|matches)|different (file|object|inode|director)|identit|dev\/ino|\binode\b/i,
  membershipChanged: /member|listing|name set|contents of|entr(y|ies)|appear|disappear|added to|removed from/i,
  expectedAbsence: /appear|was created|now (exists|present)|no longer absent|absent at verification|expected .{0,24}absen/i,
  platformRefusal: /win(dows|32)|platform|unsupported/i,
  bounds: /\b(bound|bounds|limit|limits|too many|too large|too deep|too big|exceed\w*|maximum|max)\b/i,
  // The AGENT arm of the identity gate, tightened away from REASON.callerGate
  // (which also matches the word "conductor" and so cannot discriminate the two
  // arms). AC-R38 needs the two arms to be tellable apart to pin their ORDER.
  agentCaller: /agent[- ]?(caller|identity|id\b)|caller is an agent|an agent .{0,40}(not )?authoriz|presented an agent/i,

  // ---- NEW FAMILIES (S4 baseline-list rework, decision fe861066). The list
  // (D1) replaces the deleted enforcement stamp as the sole comparator input,
  // so its own shape-validation failures need their own attribution, distinct
  // from an ordinary exactness delta (REASON.baseline/incomplete/hashMismatch/
  // staleEntry, which all presume the shape parsed and is otherwise sane).
  badVersion: /\bversion\b/i,
  unsorted: /sort|order|out of order/i,
  badHashFormat: /hash format|invalid hash|not (a )?valid (sha-?256|hex)|hex(adecimal)?/i,
  // fe861066 D5 LATCH DOMAIN: the (A) tracked-git-surface half of the one
  // latch, distinct from every (B) family above.
  trackedDirty: /tracked|\(a\)|git[- ]?visible|since head|working tree/i,
  // fe861066 D2 BOOTSTRAP's own quoted phrase (AC-R53 asserts the substring
  // verbatim as well as this family, so this regex is a looser second check).
  adoptInitialized: /baseline initialized|initialized.{0,20}no latch removed/i,
};

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const ON_WIN32 = process.platform === 'win32';

// ===========================================================================
// THE WIN32 SKIP — REQUIRED BY THE STANDING WINDOWS/LINUX PARITY REQUIREMENT,
// AND IT IS A REAL DEFECT REPAIR, NOT TIDYING.
//
// Decision 0ac7be95 R4 rules that on win32 the module REFUSES RECONCILIATION
// OUTRIGHT AND LEAVES THE LATCH PRESENT, before any I/O — the win32 arm has no
// parent binding and a path-addressed re-read would give Windows a silently
// weaker guarantee than posix. That refusal therefore answers EVERY call on a
// Windows host, so on win32:
//   * every positive-path pin (AC-R1, AC-R25, AC-R35, AC-R53, AC-R58) asserts
//     `cleared:true` against a call that correctly refuses — red tests that
//     are the SUITE being wrong, not the module;
//   * every refusal pin asserts a SPECIFIC reason family (baseline, latch shape,
//     bound, binding) against the platform refusal, which names none of them.
// So the honest arrangement is: skip the behavioural pins on win32 and pin the
// RULING ITSELF there (AC-R36, which runs its natural arm with no seam at all
// on a real Windows host). Deleting the positive-path arms instead would trade
// a red suite for a blind one. (CONSOLIDATED IN THIS PASS: the prior text here
// named "AC-R40" as the win32 ruling test — that was already wrong before this
// rework; AC-R40 is a directory-count bound pin, AC-R36 is the win32 test.
// Fixed while this exact paragraph was already open for the AC-R22 removal.)
//
// SABOTAGE FOR THIS CONSTANT ITSELF: hardcode `false`. On a posix host nothing
// changes (which is why this cannot be verified by running it here); on a
// Windows host the suite returns to red-failing AC-R1/AC-R25/AC-R35 and
// mis-attributing every refusal pin. Its correctness is a Windows-host claim
// and is disclosed as one.
// ===========================================================================
const WIN32_SKIP = ON_WIN32
  ? 'win32: decision 0ac7be95 R4 rules that reconciliation REFUSES before any I/O on this platform, so no verification-path or removal-path behaviour is observable here. AC-R36 pins that ruling natively on this host.'
  : false;

// The skip every behavioural pin in this file carries. AC-R11 (a static scan of
// agent-template frontmatter) and AC-R40 (the win32 ruling) deliberately do not.
const BEHAVIOURAL_SKIP = GIT_SKIP || WIN32_SKIP;

// Copied in shape from h17-b-taint-latch.test.mjs's SYMLINK_SKIP.
const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-reconcile-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

// Copied in shape from h17-b-taint-latch.test.mjs's UNREADABLE_SKIP.
const UNREADABLE_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-reconcile-unreadprobe-'));
    const p = join(d, 'f');
    writeFileSync(p, 'x');
    chmodSync(p, 0o000);
    try {
      readFileSync(p);
      return 'this process can read a 0o000 file (likely running as root/uid 0) — the unreadable-file fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' ? false : `unexpected error probing unreadable-file support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `unreadable-file fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(join(d, 'f'), 0o644);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

// Copied in shape from h17-b-taint-latch.test.mjs's WRITE_DENY_SKIP, but
// probing DELETION denial specifically (removing a directory entry needs the
// same write-on-directory permission bit as creating one, so this also
// verifies unlink would be denied — used by AC-R17).
const DIR_WRITE_DENY_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-reconcile-writedenyprobe-'));
    const f = join(d, 'probe');
    writeFileSync(f, 'x');
    chmodSync(d, 0o555);
    try {
      unlinkSync(f);
      return 'this process can delete a file inside a 0o555 directory (likely running as root/uid 0) — the removal-denial fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' || e.code === 'EPERM' ? false : `unexpected error probing removal-deny support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `write-deny fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(d, 0o755);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

// Probes whether an UNENUMERABLE directory (0o000) can be constructed
// honestly on this host — root can enumerate one regardless, which would make
// AC-R20's fixture a lie rather than a pin. Same idiom as UNREADABLE_SKIP.
const UNREADABLE_DIR_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-reconcile-unreaddirprobe-'));
    const sub = join(d, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'f'), 'x');
    chmodSync(sub, 0o000);
    try {
      readdirSync(sub);
      return 'this process can enumerate a 0o000 directory (likely running as root/uid 0) — the unenumerable-directory fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' ? false : `unexpected error probing unenumerable-directory support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `unenumerable-directory fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(join(d, 'sub'), 0o755);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

// Copied in shape from h17-b-taint-latch.test.mjs's makeGitProject, trimmed to
// what this file needs (no SterlingStore/run — the clearer operates on a
// project directory only, it has no dependency on a live run).
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-reconcile-'));

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  // Marker so a future H17 read of this fixture would find a real DB path,
  // even though this file never invokes H17 or the store directly.
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');

  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}
// fe861066 D1: the list lives DIRECTLY under .sterling/, NOT under
// .sterling/transient/ — persistent evidence does not belong in a
// lifecycle-bound directory (the Codex correction that overturned the
// original stamp's location).
function baselinePath(dir) {
  return join(dir, '.sterling', 'enforcement-baseline.json');
}
function coderPath(dir) {
  return join(dir, '.claude', 'agents', 'coder.md');
}
function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}
function configJsonPath(dir) {
  return join(dir, '.sterling', 'config.json');
}

const CODER_REL = '.claude/agents/coder.md';
const SETTINGS_REL = '.claude/settings.local.json';
const CONFIG_REL = '.sterling/config.json';

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// fe861066 D1: entries are a SORTED ARRAY, strictly ascending by path. Every
// fixture in this file that builds a baseline goes through this, so a fixture
// that forgets to sort cannot silently pass as "exact" — it would fail its own
// shape's sortedness the same way a real ADOPT-minted list must not.
function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// fe861066 D1's shape, wrapped around a plain entries array. `mintedAt` is
// exposed as a parameter (not hardcoded) so AC-R58 can plant an ANCIENT
// minted_at and prove it carries no authority.
function wrapBaseline(entries, mintedAt = NOW) {
  return { version: 1, minted_at: mintedAt, entries: sortEntries(entries) };
}

function writeBaseline(dir, entries, mintedAt = NOW) {
  const p = baselinePath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(wrapBaseline(entries, mintedAt)));
}

// The exact baseline for the (B) surface makeGitProject() produces — what a
// correctly-run ADOPT (scripts/enforcement-reconcile.mjs, the only sanctioned
// minter per fe861066 D2) would have written. Fabricated directly rather than
// by invoking ADOPT itself for every fixture that merely needs a valid list:
// this file's own AC-R53/AC-R54 are what pin ADOPT's minting behaviour, and
// every OTHER test needs a baseline it can independently reason about.
// fe861066 D1: entries are strictly {path, sha256} — no `at`, no `deleted`;
// a path not on disk simply has no entry at all.
function exactBaselineFor(dir) {
  return [
    { path: CODER_REL, sha256: sha256Of(coderPath(dir)) },
    { path: SETTINGS_REL, sha256: sha256Of(settingsPath(dir)) },
    { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)) },
  ];
}

function plantLatch(dir, body = { note: 'test fixture: unattested (B) modify', at: NOW, incident: [] }) {
  mkdirSync(dirname(latchPath(dir)), { recursive: true });
  writeFileSync(latchPath(dir), JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// HARNESS ADDITIONS for the S4r mutation-repair pass (AC-R25 onward).
// ---------------------------------------------------------------------------

// Repo-relative POSIX path -> absolute filesystem path. Every rel path in this
// file is written with forward slashes (the path invariant); this is the one
// place that converts, so no test hand-rolls a platform join.
function absOf(dir, rel) {
  return join(dir, ...rel.split('/'));
}

function baselineEntryFor(dir, rel) {
  return { path: rel, sha256: sha256Of(absOf(dir, rel)) };
}

// The exact baseline for the base fixture PLUS a set of extra (B) paths, each
// attested with its true current hash. Used by the BOUNDS pins: an oversized
// fixture that is nonetheless EXACTLY ATTESTED is what makes those pins strong
// — with the bound deleted the call CLEARS, so the pin goes red on the durable
// effect and not merely on wording.
function exactBaselineForWith(dir, extraRels) {
  return [...exactBaselineFor(dir), ...extraRels.map((rel) => baselineEntryFor(dir, rel))];
}

// Writes the baseline file VERBATIM (no JSON.stringify), for fixtures whose point
// is the raw byte length rather than the parsed content. AC-R44 uses it.
function writeRawBaseline(dir, text) {
  const p = baselinePath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

// A root-level directory created at FIXTURE time, used to stage swap material
// for the post-verdict substitution pins. It exists before the call starts so
// that a substitution performed mid-call changes NO directory's name set —
// which is what keeps each substitution pin isolated to the single guard it
// names (see AC-R30's comment).
function makeStaging(dir) {
  const p = join(dir, 'staging');
  mkdirSync(p, { recursive: true });
  return p;
}

// R6 detectors. Both arms matter and neither subsumes the other: an
// `async function` is caught by the first, a SYNC function that returns a
// promise (`() => somethingAsync()`) is caught only by the second, and it is
// the second shape a well-meaning refactor produces.
function looksAsyncFunction(fn) {
  return (
    typeof fn === 'function' &&
    (fn.constructor?.name === 'AsyncFunction' || Object.prototype.toString.call(fn) === '[object AsyncFunction]')
  );
}
function isThenable(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

// dev:ino as strings — bigint so a large inode is never silently rounded by a
// Number, which would make a "the identity changed" fixture-control assertion
// pass while the identities were actually equal.
function identityOf(p) {
  const st = lstatSync(p, { bigint: true });
  return `${st.dev}:${st.ino}`;
}

// Baseline entries for an arbitrary list of repo-relative (B) paths, hashed from
// current disk. Companion to exactBaselineFor(), which covers only the three
// paths makeGitProject() creates.
function baselineEntriesFor(dir, rels) {
  return rels.map((rel) => ({ path: rel, sha256: sha256Of(join(dir, ...rel.split('/'))) }));
}

// THE BOUND-EVIDENCE REFUSAL FAMILIES. Same discipline as REASON above: the
// discriminating power lives as much in the NEGATIVE assertions (doesNotMatch)
// as in the positive ones, because three refusal conditions in this module once
// returned {cleared:false} indistinguishably and that is how a hollow pin
// shipped here before.
const BINDING = {
  // "the evidence no longer matches what the verdict was computed from" — the
  // umbrella family for a broken binding of any of the four properties.
  broken:
    /changed (during|between|after|since)|no longer (the same|matches|match|identical|resolves|reaches|refers)|re-?bound|re-?bind|bound evidence|substitut|swapped|identity (changed|mismatch|differs)|different inode|dev\/ino|not the (same|one) (file|object|inode|directory)/i,
  // (c): the directory's (B)-relevant NAME SET changed.
  membership: /membership|name ?set|entry set|appeared|new entry|added (entry|member|file)|disappear|no longer listed|removed (from|during)|vanish/i,
  // (d): the BASELINE's own binding, as distinct from any (B) leaf's.
  baselineBinding: /baseline/i,
  // R3: the retained directory chain no longer reaches the LIVE path.
  liveNamespace:
    /live (path|tree|namespace|repository|directory)|no longer reach|no longer resolve|re-?bound|re-?bind|detach|replaced director|director[a-z]* (was )?(renamed|replaced|swapped|substituted)|\bedge\b|parent (changed|no longer)/i,
};

// THE ENUMERATION-BOUND VOCABULARY. `REASON.bounds` says only "a bound fired";
// these say WHICH ONE, which is what stops the confusable pairs (file COUNT vs
// per-file SIZE vs TOTAL size) collapsing into one another and lets a single
// bound's deletion be seen.
const LIMIT = /\b(limit|limits|bound|bounded|maximum|max|too many|too large|too deep|exceed|exceeds|exceeded|cap|capped|budget)\b/i;
const DIMENSION = {
  depth: /\bdepth\b|\bnest(ed|ing)?\b|too deep/i,
  dirCount: /director/i,
  fileCount: /\bfiles?\b/i,
  dirents: /\bentr(y|ies)\b|\bdirent/i,
  size: /\b(size|bytes|byte|MiB|MB|KiB|KB)\b/i,
  total: /\btotal\b|\baggregate\b|\bcombined\b|\bcumulative\b|\boverall\b/i,
};

// ---------------------------------------------------------------------------
// THE PER-FIXTURE CONTROL. A post-verdict-tamper pin's verdict has MORE THAN
// ONE possible cause: "the guard I named fired" and "this fixture cannot clear
// at all / supplying SEAM 4 denies". AC-R25 is the file-wide control for the
// second cause, but a pin whose FIXTURE differs from AC-R25's (an extra file,
// an absent root, a staging directory) needs its own — otherwise a green
// carries no evidence about ITS fixture. This helper runs the caller's fixture
// with a NO-OP SEAM-4 hook and requires it to CLEAR; every substitution pin
// below calls it FIRST.
// ---------------------------------------------------------------------------
async function assertFixtureClearsWithNoopConfirm(buildFixture, label) {
  const { dir, cleanup } = buildFixture();
  try {
    let beforeFired = 0;
    let insideFired = 0;
    // BOTH hooks are SYNCHRONOUS and return undefined on purpose:
    // `_testHookInsideConfirm` is CALLED, NOT AWAITED, and a thenable return
    // REFUSES — an `async () => {}` here would make every control arm fail for
    // a reason that has nothing to do with the fixture.
    const r = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeConfirm: () => {
        beforeFired += 1;
      },
      _testHookInsideConfirm: () => {
        insideFired += 1;
      },
    });
    assert.equal(beforeFired, 1, `PER-FIXTURE CONTROL (${label}): SEAM 4 (_testHookBeforeConfirm) must fire exactly once on this fixture too`);
    assert.equal(insideFired, 1, `PER-FIXTURE CONTROL (${label}): SEAM 4b (_testHookInsideConfirm) must fire exactly once on this fixture too — a pin whose seam never fires injects nothing and is not a pin`);
    assert.equal(
      r.cleared,
      true,
      `PER-FIXTURE CONTROL (${label}): THIS EXACT FIXTURE, untampered and with BOTH confirm seams supplied, must CLEAR. Without this arm the refusal below has two possible causes — the guard fired, or this fixture/seam combination simply cannot reconcile — and a green would carry no evidence. reason: ${reasonOf(r)}`
    );
    assert.equal(existsSync(latchPath(dir)), false, `PER-FIXTURE CONTROL (${label}): the latch is genuinely removed on the untampered run`);
  } finally {
    cleanup();
  }
}

// ===========================================================================
// AC-R1 — THE HEADLINE / CONTROL, PLACED FIRST. Serves as the control for
// every refusal test below: it proves the mechanism can actually clear under
// the correct conditions, so a DENY anywhere else in this file cannot be
// explained by "the clearer refuses unconditionally". It also pins the
// ORDERING half of the contract (item 3) and the LAUNDERING half (item 1's
// "producer cannot clear"): a baseline appearing on disk — however it got there —
// never by itself removes the latch; only the explicit, separate
// reconcileEnforcementTaint() call does.
//
// EXPECTED: GREEN. This is the file's standing positive control and it is
// deliberately WEAK on its own — an always-succeeds stub would satisfy the
// final `existsSync(latchPath(dir)) === false`, and AC-R2 onward are what catch
// that. What this arm exists to prove is that the POSITIVE PATH IS REACHABLE AT
// ALL, so a refusal anywhere else in the file cannot be explained by "the
// clearer refuses unconditionally". If IT goes red, treat every other verdict in
// this file as uninterpretable until it is green again.
//
// (The first assertion — latch still present immediately after the fabricated
// baseline appears, BEFORE reconcileEnforcementTaint is ever called — is the
// laundering half and is independent of the module entirely.)
//
// SABOTAGE: make reconcileEnforcementTaint a no-op that never removes the
// latch even on an exact match — `existsSync(latchPath(dir))` after the call
// stays true instead of becoming false, and `result.cleared` stays false.
// ===========================================================================
test('AC-R1 CONTROL: fabricating a valid baseline does NOT by itself clear the latch; only the explicit reconcile call does, and it succeeds on an exact match', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    assert.equal(existsSync(latchPath(dir)), true, 'PRECONDITION: latch is present');

    writeBaseline(dir, exactBaselineFor(dir));
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      'THE LAUNDERING PIN: a baseline appearing on disk (by any means — this is exactly what a background child minting a baseline over tampered bytes would produce) never by itself clears the latch; minting is not clearing'
    );

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, true, `an exact baseline for the current (B) surface must clear — reason: ${reasonOf(result)}`);
    assert.equal(typeof result.reason, 'string', 'the return contract carries a reason on the success path too');
    assert.ok(reasonOf(result).length > 0, 'the success reason is never an empty string — every verdict is attributable');
    assert.equal(existsSync(latchPath(dir)), false, 'THE RULING: reconciliation removes the latch on an exact match');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R2 — BASELINE ABSENT REFUSES, EVEN WHEN THE (B) SURFACE IS ALREADY
// SELF-CONSISTENT (matches its as-committed HEAD state, nothing tampered).
// This is deliberately the sharpest form of "a baseline that exactly equals the
// current (B) surface is NOT sufficient on its own" (task item: a baseline must
// be independently trusted, not merely self-consistent) — here there is no
// baseline file AT ALL, and the surface looks perfectly fine, and it must STILL
// refuse, because "looks fine" is not "was attested".
//
// EXPECTED FAILURE SHAPE (RED): before() throws (module absent). Once any
// module exists: a naive "if nothing looks tampered, allow" implementation
// would pass, so this pin's discriminating power depends on the module
// actually consulting the baseline path rather than re-deriving trust from
// current disk state.
//
// SABOTAGE: treat a missing baseline as "nothing to verify against, so trust
// current disk state" and clear anyway — `result.cleared` flips true, and
// `existsSync(latchPath(dir))` flips false.
// ===========================================================================
test('AC-R2: baseline file ABSENT refuses, even though the (B) surface is currently self-consistent (never touched)', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    assert.equal(existsSync(baselinePath(dir)), false, 'PRECONDITION: no baseline exists');

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `an absent baseline must refuse to clear — reason: ${oneLine(result.reason)}`);
    assert.match(oneLine(result.reason), /baseline/i, 'the refusal reason names the baseline');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an absent-baseline refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R3 — MALFORMED COMPARATOR INPUT (decision fe861066 D1/D4): unparseable
// JSON, a bad `version`, out-of-order entries, duplicate path entries, and a
// badly-formatted hash all refuse — the list's SHAPE must be valid before its
// CONTENT is ever compared against current disk. Rework absorbs the old
// stamp-era AC-R3 (unparseable JSON) and AC-R6 (duplicate entry, isolated from
// a hash mismatch by using a matching hash) into ONE multi-arm test, because
// fe861066 D1 states plainly that duplicate/unsorted entries are a SHAPE
// question ("array not object, so duplicate keys are detectable without a raw
// JSON parser"), not a delta-from-current question — AC-R4/AC-R5/AC-R7 below
// stay the delta-direction pins.
//
// EACH ARM IS AGAINST AN OTHERWISE-VALID (B) SURFACE (AC-R1's fixture), so a
// refusal cannot be explained by anything the (B) surface itself is doing —
// only the single named shape defect.
//
// SABOTAGE (one line, per arm): wrap the parse/shape-validation in a bare
// `try { ... } catch { entries = [] }` (or skip validating one of the four
// shape properties) — the call then refuses down the INCOMPLETE path instead
// (an empty manifest is missing every current path), so `cleared:false` still
// holds and only the malformed-family / specific-family reason assertions
// fire. That substitution is precisely the hollowness class this repair pass
// exists to close.
// ===========================================================================
test('AC-R3: malformed comparator input (unparseable JSON, bad version, unsorted entries, duplicate path entries, bad hash format) all refuse — latch survives', { skip: BEHAVIOURAL_SKIP }, async () => {
  const arms = [
    {
      label: 'unparseable JSON',
      write: (dir) => writeFileSync(baselinePath(dir), '{ not valid json,,,'),
      family: REASON.malformed,
    },
    {
      label: 'bad version (2 instead of 1)',
      write: (dir) => writeFileSync(baselinePath(dir), JSON.stringify({ version: 2, minted_at: NOW, entries: sortEntries(exactBaselineFor(dir)) })),
      family: REASON.badVersion,
    },
    {
      label: 'version omitted entirely',
      write: (dir) => writeFileSync(baselinePath(dir), JSON.stringify({ minted_at: NOW, entries: sortEntries(exactBaselineFor(dir)) })),
      family: REASON.badVersion,
    },
    {
      label: 'entries out of ascending order',
      write: (dir) => {
        const entries = sortEntries(exactBaselineFor(dir));
        // A single adjacent swap is enough to violate strict ascending order
        // without touching content — isolates "shape" from every delta family.
        const swapped = [entries[1], entries[0], entries[2]];
        writeFileSync(baselinePath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries: swapped }));
      },
      family: REASON.unsorted,
    },
    {
      label: 'duplicate path entry (matching hash — isolates duplication from hash mismatch)',
      write: (dir) => {
        const entries = sortEntries(exactBaselineFor(dir));
        const dup = entries.find((e) => e.path === CODER_REL);
        // The duplicate sorts adjacent to its twin, so this is still an
        // otherwise well-ordered array — the ONLY defect is the repeat.
        const withDup = entries.flatMap((e) => (e.path === CODER_REL ? [e, { ...dup }] : [e]));
        writeFileSync(baselinePath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries: withDup }));
      },
      family: REASON.duplicate,
    },
    {
      label: 'bad hash format (not lowercase 64-hex)',
      write: (dir) => {
        const entries = sortEntries(exactBaselineFor(dir)).map((e) => (e.path === CODER_REL ? { ...e, sha256: 'NOT-A-VALID-SHA256' } : e));
        writeFileSync(baselinePath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries }));
      },
      family: REASON.badHashFormat,
    },
  ];

  for (const arm of arms) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      mkdirSync(dirname(baselinePath(dir)), { recursive: true });
      arm.write(dir);

      const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
      assert.equal(result.cleared, false, `${arm.label}: a malformed baseline must refuse — reason: ${reasonOf(result)}`);
      // NOTE: only the arm's SPECIFIC family is required, not the generic
      // REASON.malformed wrapper too — a deliberate "bad version" or
      // "unsorted" guard need not also spell the word "malformed", and
      // demanding both would fail a compliant implementation on wording
      // alone. The specific family is what discriminates the five arms from
      // each other; that is the load-bearing assertion.
      assert.match(reasonOf(result), arm.family, `${arm.label}: the refusal must name its SPECIFIC shape defect, or five arms collapse into one undiscriminated family — reason: ${reasonOf(result)}`);
      assert.doesNotMatch(reasonOf(result), REASON.noLatch, `${arm.label}: a malformed baseline is not a no-latch no-op`);
      assert.equal(existsSync(latchPath(dir)), true, `${arm.label}: the latch survives a malformed-baseline refusal`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// AC-R4 — BASELINE INCOMPLETE: it attests only two of the three current (B)
// paths, silently omitting one that currently exists on disk. Exact-SET
// equality means an attested subset is not enough.
//
// SABOTAGE: validate only the entries the baseline DOES contain (subset
// comparison) instead of requiring every current (B) path to have an entry —
// `result.cleared` flips true.
// ===========================================================================
test('AC-R4: a baseline that omits a currently-existing (B) path refuses (subset is not exact)', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const full = exactBaselineFor(dir);
    writeBaseline(dir, full.filter((e) => e.path !== SETTINGS_REL)); // omit settings.local.json

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `an incomplete baseline must refuse — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.incomplete, `the refusal is attributed to the INCOMPLETE-baseline guard — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), /settings\.local\.json/, 'the refusal names the (B) path that has no baseline entry — an unattributable "something did not match" is not a usable verdict');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an incomplete-baseline refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R5 — BASELINE HASH MISMATCH: an entry names a current (B) path but with a
// hash that does not match its actual current bytes.
//
// SABOTAGE: compare only PATH PRESENCE, not the hash value — `result.cleared`
// flips true.
// ===========================================================================
test('AC-R5: a baseline entry whose hash does not match its current (B) path bytes refuses', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const wrongHash = createHash('sha256').update('not the real bytes').digest('hex');
    const full = exactBaselineFor(dir);
    writeBaseline(
      dir,
      full.map((e) => (e.path === CODER_REL ? { ...e, sha256: wrongHash } : e))
    );

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `a hash-mismatched baseline entry must refuse — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.hashMismatch, `the refusal is attributed to the HASH guard, not to a set-shape guard — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), /coder\.md/, 'the refusal names the offending path');
    assert.doesNotMatch(reasonOf(result), REASON.changed, 'nothing changed mid-flight here — a TOCTOU reason would be a misattribution');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a hash-mismatch refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R7 — BASELINE LISTS A PATH THAT NO LONGER EXISTS in the current (B) set
// (attested, then deleted before reconciliation was attempted). Exact-SET
// equality runs both directions: the baseline must not claim more than the
// current surface has, just as AC-R4 shows it must not claim less.
//
// DISSOLVED CONTRAST: the old contrast pair here (AC-R22/AC-R23, a
// `deleted:true` per-entry attestation) DISSOLVES under fe861066 D1 — the
// list's entries are strictly `{path, sha256}`, with no per-entry deletion
// field at all, so there is no way to attest a deletion; a path simply has no
// entry. This test's shape (an entry naming a path that no longer exists) is
// unaffected and stays the sole "stale entry" pin.
//
// SABOTAGE: only check "every current path has a matching baseline entry"
// (AC-R4's direction) without also checking "every baseline entry has a
// currently-existing path" — `result.cleared` flips true.
// ===========================================================================
test('AC-R7: a baseline entry for a (B) path that no longer exists on disk refuses (exactness runs both directions)', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const extraPath = join(dir, '.claude', 'agents', 'removed-agent.md');
    writeFileSync(extraPath, '# will be deleted before reconciliation\n');
    const full = exactBaselineFor(dir);
    const extraHash = sha256Of(extraPath);
    writeBaseline(dir, [...full, { path: '.claude/agents/removed-agent.md', sha256: extraHash }]);
    rmSync(extraPath); // now the baseline claims a path the current (B) set does not have

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `a baseline entry with no corresponding current (B) path must refuse — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.staleEntry, `the refusal is attributed to the STALE-ENTRY direction of exactness, not to AC-R4's opposite direction — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), /removed-agent\.md/, 'the refusal names the baseline entry that no longer has a path');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a stale-baseline-entry refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R8 — TOCTOU: the (B) SURFACE mutates between the internal verification
// (baseline read + (B) enumeration/hash + verdict) and the removal. Uses the
// TEST-ONLY hook to inject the mutation deterministically at exactly that
// seam, isolating this from AC-R1's success fixture by the single variable of
// "does something change mid-flight".
//
// REPAIR (independent mutation verifier, S4r): this pin and AC-R9 were judged
// LEGITIMATE DEFENCE IN DEPTH but neither could say WHICH guard fired — a
// second verification pass reporting a plain "hash mismatch" is
// indistinguishable from an ordinary AC-R5 refusal, so the TOCTOU abort was
// unpinned even while the test was green. The reason assertions below are the
// discriminator: the verdict must be attributed to a CHANGE DETECTED DURING
// VERIFICATION, and must NOT read as an ordinary manifest mismatch.
//
// SABOTAGE: compute the verdict once and act on it without a final
// re-confirmation immediately before the (irreversible) removal — the latch
// gets removed even though the (B) surface changed after the verdict was
// computed; `existsSync(latchPath(dir))` flips from true to false.
// SECOND SABOTAGE (aimed at the new discriminator): keep the second pass but
// report its outcome with the ordinary mismatch wording — the
// changed-during-verification assertion fires while `cleared:false` still
// holds, which is exactly the ambiguity this repair removes.
// ===========================================================================
test('AC-R8: the (B) surface mutating between verification and removal aborts the clear — latch survives', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // exact at the moment reconcile starts

    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookAfterEnumeration: async () => {
        writeFileSync(coderPath(dir), '# mutated mid-flight, after verification, before removal\n');
      },
    });
    assert.equal(result.cleared, false, `a (B) surface mutation during verification must abort the clear — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.changed, `THE DISCRIMINATOR: the verdict must be attributed to a CHANGE DETECTED DURING VERIFICATION — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'a plain manifest-mismatch reason cannot distinguish this from AC-R5, which leaves the TOCTOU abort unpinned even on a green run');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a mid-flight (B) mutation — the race must abort, not clear on a stale verdict');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R9 DISSOLVED. The old pin ("the STAMP mutates between verification and
// removal") tested the ephemeral per-call attestation stamp deleted by
// decision 78dc9bd6. Its TOCTOU role is INHERITED by the persistent baseline
// LIST file: see AC-R52 at the end of this file, which pins the identical
// race against the list using the same `_testHookAfterEnumeration` seam —
// expressible without any new harness machinery, so nothing here needed to be
// pinned "weaker and called the same thing".
// ===========================================================================
// AC-R10 — CONDUCTOR-ONLY. The fixture is IDENTICAL to AC-R1's success
// fixture (exact baseline, real latch) except for `callerAgentId` — isolating
// the identity gate as the SOLE cause of refusal. Without this isolation, a
// refusal here could equally be explained by some unrelated defect in the
// verification path; because AC-R1 proves this exact fixture would otherwise
// succeed, a refusal here can only be the identity gate.
//
// This is also half of what closes the laundering/background-child attack
// named at the top of this file: even a child that reproduces a valid baseline
// cannot itself invoke this operation successfully while claiming to be an
// agent.
//
// REPAIR (S4r, conductor ruling R-F): this call now ALSO passes the explicit
// conductor assertion. That is not a softening — it is what keeps the pin
// discriminating under the inverted default. Without it, this fixture would
// refuse because the conductor assertion is MISSING (AC-R24's gate) and the
// agent-identity gate would never be reached, so the test would go green while
// pinning nothing about `callerAgentId` at all — the same substitution defect
// that made AC-R15 hollow. In its repaired form it pins something strictly
// STRONGER: a caller that ASSERTS conductorhood while carrying an agent
// identity is still refused, which is the spoof shape that matters.
//
// SABOTAGE: ignore `callerAgentId` entirely (accept any caller whose
// callerRole is 'conductor') — `result.cleared` flips true.
// ===========================================================================
test('AC-R10: a caller presenting an agent identity is refused even against AC-R1\'s exact-match success fixture — conductor-only', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // identical to AC-R1's proven-success fixture

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, callerAgentId: 'agent-abc123' });
    assert.equal(result.cleared, false, `an agent-identified caller must be refused even on an otherwise-exact fixture, and even when it asserts conductorhood — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.callerGate, 'the refusal names the identity/authorization gate');
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the fixture HAS a latch — a no-op reason here would mean the identity gate never fired');
    assert.doesNotMatch(
      reasonOf(result),
      REASON.missingConductorAssertion,
      'THE DISCRIMINATOR vs AC-R24: the conductor assertion IS present here. A missing-assertion reason would mean this fixture is measuring the omission gate, not the agent-identity gate'
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an agent-identified call');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R11 — STATIC GRANT-SURFACE CHECK (GREEN NOW — a regression tripwire, not
// a red-today pin, disclosed as such per this repo's own convention for this
// shape, e.g. h17-b-taint-latch.test.mjs's AC-L7). This file names the MCP
// tool `enforcement_reconcile` as the canonical exposure surface (see the
// header comment) precisely so this test has something concrete to check; if
// the implementer binds the MCP tool to a different name, this test must be
// updated to match — that is a deliberate consequence of pinning an
// interface this file had to invent.
//
// WHAT IT PINS: no agent template (source-of-truth for what an agent's
// frontmatter grants once installed) lists this tool name among its granted
// tools. This does not, by itself, prove the MCP SERVER refuses an agent that
// somehow invoked the tool anyway (AC-R10 covers the runtime gate) — it only
// proves the tool is not handed to any agent role in the first place.
//
// REPAIR (outside-model review, S4r): THE ORIGINAL WAS A WHOLE-FILE STRING
// SCAN. `/enforcement_reconcile/.test(body)` matches the token ANYWHERE in a
// template — in prose, in a comment, in an instruction that says "never call
// enforcement_reconcile" — so the pin false-positives on exactly the sentence
// a careful template author would write. That is the SAME defect class this
// whole objective exists to eliminate (substring scanning where structural
// parsing is required), reproduced inside its own test suite. The scan is now
// scoped structurally to the frontmatter `tools:` grant.
//
// SURFACED, NOT PINNED (conductor's call, deliberately not asserted here): a
// template with NO `tools:` key at all inherits the full tool set, and would
// therefore be granted this tool once the MCP operation ships. That is a
// property of the ROSTER, not of the clearer, and asserting it here would
// couple this suite to an unrelated registry decision. The count is reported
// in the failure message so it cannot stay invisible.
//
// SABOTAGE: add `enforcement_reconcile` (or
// `mcp__plugin_sterling_sterling__enforcement_reconcile`) to any agent
// template's frontmatter `tools:` list — `offenders` becomes non-empty.
// SECOND SABOTAGE (aimed at the vacuity risk a structural parser introduces):
// break `grantedTools` so it returns null for every real template (e.g. make
// the frontmatter regex require `\n---\n` at the very start of a line it never
// sees) — the scan would otherwise pass VACUOUSLY over zero templates; the
// CONTROL assertions fire instead.
// ===========================================================================

// Structural frontmatter parser. Returns the array of tool tokens granted by a
// template's YAML frontmatter `tools:` key, or null when the template has no
// frontmatter or no `tools:` key (which, in this platform, means "inherits
// everything" — see the SURFACED note above). Handles the three shapes that
// occur in practice:
//   tools: Read, Grep, mcp__server__thing     (inline scalar list)
//   tools: [Read, Grep]                        (inline flow sequence)
//   tools:\n  - Read\n  - Grep                 (block sequence)
function grantedTools(templateText) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(String(templateText));
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^tools\s*:/.test(l));
  if (idx === -1) return null;

  const tokens = [];
  const push = (s) => {
    for (const raw of String(s).split(/[,\s]+/)) {
      const t = raw.trim().replace(/^["'\[]+|["'\],]+$/g, '');
      if (t) tokens.push(t);
    }
  };

  push(lines[idx].replace(/^tools\s*:/, ''));
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*-\s+/.test(l)) push(l.replace(/^\s*-\s+/, ''));
    else if (l.trim() === '') continue;
    else break; // the next key (top-level or otherwise) ends the tools block
  }
  return tokens;
}

// A grant token names this tool if its bare name — after any `mcp__server__`
// prefix — is exactly `enforcement_reconcile`.
function grantsEnforcementReconcile(tokens) {
  return (tokens ?? []).some((t) => t.split('__').pop() === 'enforcement_reconcile');
}

test('AC-R11: no agent template GRANTS the enforcement_reconcile tool in its frontmatter tools: list (conductor-only exposure, structural check)', () => {
  // ---- CONTROL ARM 1, PLACED FIRST: the parser DETECTS a genuine grant. A
  // green scan below means nothing unless the detector can actually see a
  // grant when one is there. Must pass for the OPPOSITE reason to the pin.
  assert.equal(grantsEnforcementReconcile(grantedTools('---\ntools: Read, enforcement_reconcile\n---\nbody\n')), true, 'CONTROL: an inline grant must be detected');
  assert.equal(
    grantsEnforcementReconcile(grantedTools('---\nname: x\ntools:\n  - Read\n  - mcp__plugin_sterling_sterling__enforcement_reconcile\nmodel: opus\n---\n')),
    true,
    'CONTROL: a block-sequence grant, mcp-prefixed, must be detected'
  );
  assert.equal(grantsEnforcementReconcile(grantedTools('---\ntools: [Read, enforcement_reconcile]\n---\n')), true, 'CONTROL: a flow-sequence grant must be detected');

  // ---- CONTROL ARM 2: the repair itself. A mention OUTSIDE the tools: grant
  // is NOT a grant. This is the false-positive the whole-file scan produced.
  assert.equal(
    grantsEnforcementReconcile(grantedTools('---\nname: coder\ntools: Read, Grep\n---\nNever call enforcement_reconcile — it is conductor-only.\n')),
    false,
    'CONTROL: a prose mention in the body is not a grant'
  );
  assert.equal(
    grantsEnforcementReconcile(grantedTools('---\nname: coder\ntools: Read\ndescription: must never invoke enforcement_reconcile\n---\n')),
    false,
    'CONTROL: a mention in a SIBLING frontmatter key is not a grant'
  );

  // ---- THE SCAN.
  const dirPath = join(root, 'agent-templates');
  const names = ['implementation-architect.md', 'researcher.md', 'reviewer-correctness.md', 'reviewer-performance.md', 'reviewer-security.md', 'reviewer-skeptic.md', 'librarian.md', 'test-writer.md', 'coder.md', 'debugger.md', 'explorer.md'];
  const offenders = [];
  const parsed = [];
  const inheritsAll = [];
  for (const name of names) {
    const p = join(dirPath, name);
    if (!existsSync(p)) continue; // registry drift is a separate concern from this pin
    const tokens = grantedTools(readFileSync(p, 'utf8'));
    if (tokens === null) {
      inheritsAll.push(name);
      continue;
    }
    parsed.push(name);
    if (grantsEnforcementReconcile(tokens)) offenders.push(name);
  }

  // ---- CONTROL ARM 3: the scan is not vacuous. A structural parser that
  // silently matches nothing produces a green run indistinguishable from a
  // clean roster.
  assert.ok(
    parsed.length >= 1,
    `CONTROL: at least one shipped template must parse to a frontmatter tools: grant, or this scan proves nothing — parsed 0 of ${names.length} (no-tools-key: ${inheritsAll.join(', ') || 'none'})`
  );

  assert.deepEqual(
    offenders,
    [],
    `THE RULING: enforcement_reconcile must never be GRANTED in agent frontmatter — offending templates: ${offenders.join(', ')} (templates with no tools: key, which inherit everything and are surfaced but not pinned here: ${inheritsAll.join(', ') || 'none'})`
  );
});

// ===========================================================================
// AC-R12 — LATCH ABSENT: nothing to reconcile. Must be a genuine no-op — it
// must never falsely report a clear that did not happen, and it must not
// create a baseline, a latch, or otherwise leave a side effect.
//
// SABOTAGE: report `cleared:true` unconditionally when no latch is found
// (conflating "nothing to do" with "successfully cleared something") — a
// caller trusting this return value would then believe an incident was
// discharged when none existed. `result.cleared` assertion flips.
// ===========================================================================
test('AC-R12: with no latch present, reconciliation is a no-op — never falsely claims a clear happened', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists');
    writeBaseline(dir, exactBaselineFor(dir)); // even with a perfectly valid baseline present

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `reconciling with no latch present must not report a clear — reason: ${reasonOf(result)}`);
    // This is the POSITIVE half of the pair AC-R15 asserts the negative of: the
    // no-latch no-op has its OWN wording, and an unreadable latch must never
    // borrow it. If this family is ever widened until it also covers "the latch
    // could not be read", AC-R15 goes hollow again.
    assert.match(reasonOf(result), REASON.noLatch, `the no-op verdict is attributed to there being NO LATCH — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'no latch is spuriously created by a no-op reconcile');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R13 — LATCH SHAPE ABNORMAL: a DIRECTORY sitting at the latch path, with
// an otherwise-exact baseline (isolating shape as the sole variable from AC-R1's
// success fixture). An abnormal latch shape must not be clearable.
//
// REPAIR (independent mutation verifier, S4r): THE ORIGINAL NAMED SABOTAGE WAS
// OFF-SHAPE. `rmSync{recursive:true}` alone left this test green, and so did
// STRIPPING BOTH SHAPE GUARDS while keeping `unlinkSync` — because unlinkSync
// on a directory fails with EISDIR and that accident silently carried the
// verdict. The reason assertion below is what makes the shape guard
// load-bearing: it demands wording a DELIBERATE shape check emits, which the
// raw errno text ("EISDIR: illegal operation on a directory, unlink '...'")
// does not satisfy. Do not add EISDIR to REASON.latchAbnormalShape — that
// single edit reinstates the hollowness.
//
// SABOTAGE: remove the "is this a regular file?" classification and let the
// removal primitive discover the shape by failing — `cleared:false` still
// holds and the directory still survives, but the reason is a raw errno, so
// the REASON.latchAbnormalShape assertion fires. (The older sabotage — a naive
// `rmSync(latchPath, {recursive:true})` reporting success — remains valid and
// fires the `cleared` and directory-survives assertions.)
// ===========================================================================
test('AC-R13: a DIRECTORY at the latch path is not clearable — refuses, directory survives', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(latchPath(dir), { recursive: true });
    writeBaseline(dir, exactBaselineFor(dir));

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `a directory at the latch path must refuse to clear — reason: ${reasonOf(result)}`);
    assert.match(
      reasonOf(result),
      REASON.latchAbnormalShape,
      `THE DISCRIMINATOR: the refusal must come from a deliberate SHAPE guard, not from unlinkSync happening to fail with EISDIR — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'a directory at the latch path is not an absent latch');
    assert.equal(lstatSync(latchPath(dir)).isDirectory(), true, 'the directory survives untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R14 — LATCH SHAPE ABNORMAL: a SYMLINK sitting at the latch path FROM THE
// START (before reconcile is ever called), pointing at a VICTIM file with
// known content elsewhere in the project. Otherwise-exact baseline, isolating
// shape as the sole variable. This directly pins BOTH "abnormal shape is not
// clearable" and "a planted symlink at the latch path must not redirect the
// removal" for the simplest form of that attack (the symlink is already
// there when reconcile starts, as opposed to AC-R16's mid-flight swap).
//
// SABOTAGE: classify the latch by its FINAL resolved target instead of by the
// leaf's own (unfollowed) shape, or perform the removal without a no-follow
// primitive — the victim's content assertion fires (the target got
// truncated/deleted) and/or `result.cleared` flips true.
// ===========================================================================
test('AC-R14: a SYMLINK at the latch path (pointing at a victim file) from the start is not clearable — refuses, victim untouched', { skip: BEHAVIOURAL_SKIP || SYMLINK_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const victimPath = join(dir, 'VICTIM.txt');
    const victimBytes = Buffer.from('DO NOT TOUCH — this file is outside the (B) surface and outside .sterling\n');
    writeFileSync(victimPath, victimBytes);
    symlinkSync(victimPath, latchPath(dir));
    writeBaseline(dir, exactBaselineFor(dir));

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `a symlinked latch path must refuse to clear — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.latchAbnormalShape, `the refusal is attributed to the PRE-EXISTING abnormal shape — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.midFlightSwap, 'nothing was swapped mid-flight here; the abnormal shape was there from the start (AC-R16 is the swap case, and the two must stay distinguishable)');
    assert.equal(lstatSync(latchPath(dir)).isSymbolicLink(), true, 'the symlink itself is left alone, not silently replaced');
    assert.deepEqual(readFileSync(victimPath), victimBytes, 'THE RULING: a planted symlink at the latch path must never redirect the removal onto its target');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R15 — LATCH SHAPE ABNORMAL: an UNREADABLE regular file (0o000) at the
// latch path, otherwise-exact baseline. "An unreadable latch is not an absent
// one" — the task's own words for this exact case.
//
// REPAIR (independent mutation verifier, S4r) — THIS PIN WAS MEASURED HOLLOW.
// Its named sabotage (map the EACCES to `{kind:'absent'}`) left the suite
// 17/17 GREEN: the call then fell into AC-R12's NO-LATCH path, which also
// returns `{cleared:false}` and also leaves the mode bits alone, so BOTH of
// this test's assertions still held while the invariant it names — "an
// unreadable latch is not an absent one" — was fully inverted. It was pinning
// "permissions untouched", nothing more. The two reason assertions below are
// the actual pin: the verdict must be attributed to UNREADABILITY, and must
// NOT read as the no-latch no-op that AC-R12 owns.
//
// SABOTAGE: catch the EACCES on the read and fall back to "no latch found,
// nothing to do" — `cleared` and the mode bits are unchanged (that is the
// hollowness), but REASON.latchUnreadable now fails to match and
// REASON.noLatch now matches, so BOTH new assertions fire.
// SECOND SABOTAGE: "repair" the permissions while handling the error (chmod
// 0o644 then read) — the mode-bits assertion fires.
// ===========================================================================
test('AC-R15: an UNREADABLE regular file at the latch path is not clearable — refuses, permissions untouched', { skip: BEHAVIOURAL_SKIP || UNREADABLE_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    chmodSync(latchPath(dir), 0o000);
    writeBaseline(dir, exactBaselineFor(dir));

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, false, `an unreadable latch must refuse to clear — reason: ${reasonOf(result)}`);
    assert.match(
      reasonOf(result),
      REASON.latchUnreadable,
      `THE RULING, AND THE WHOLE PIN: the verdict must be attributed to the latch being UNREADABLE — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(
      reasonOf(result),
      REASON.noLatch,
      'AN UNREADABLE LATCH IS NOT AN ABSENT ONE: falling through to AC-R12\'s no-latch no-op is the exact inversion this test exists to catch, and it is invisible without this assertion'
    );
    assert.equal(statSync(latchPath(dir)).mode & 0o777, 0, 'the permission bits are never "fixed" by reconciliation in the course of refusing');
  } finally {
    try {
      chmodSync(latchPath(dir), 0o644);
    } catch {}
    cleanup();
  }
});

// ===========================================================================
// AC-R16 — REMOVAL-TIME SYMLINK SWAP (the harder half of item 6): the latch
// STARTS as a normal, valid, exactly-attested regular file (verification
// succeeds against it, exactly like AC-R1), but the TEST-ONLY hook swaps it to
// a symlink pointing at a victim file in the exact window between
// verification and the removal call — simulating an attacker racing the
// clearer rather than a pre-existing abnormal shape (AC-R14 covers that
// simpler case). The removal primitive itself must be no-follow / re-verify
// immediately before acting, not a bare `unlink(path)` resolved fresh at
// removal time.
//
// REPAIR (independent mutation verifier, S4r) — THIS PIN RESOLVED TO ANOTHER
// TEST'S GUARD. The author claimed a pair of guards carried it; the verifier
// stripped BOTH and it stayed green, because an ACCIDENTAL THIRD LAYER was
// doing the work: the leaf classifier returns a null stat on its ELOOP branch,
// `h.st.dev` then throws a TypeError, and the outer catch converts that into
// `{cleared:false}`. The guard actually carrying the verdict was O_NOFOLLOW —
// which AC-R14 ALREADY PINS — so this test added no independent power at all.
// The repair gives it its own: the verdict must be attributed to a MID-FLIGHT
// SWAP, distinctly from the PRE-EXISTING abnormal shape AC-R14 produces. That
// forces the implementation to distinguish "abnormal when first classified"
// from "changed since it was classified", which is the only thing this fixture
// is actually about.
//
// The victim-bytes assertion is DEMOTED to a cheap safety net and is
// deliberately no longer what this test rests on: the verifier confirmed it is
// TAUTOLOGICAL, since `unlinkSync` removes the link itself and never its
// target, so it cannot fail for the reason its old message claimed.
//
// SABOTAGE: report the swap with AC-R14's pre-existing-shape wording (e.g.
// return "not a regular file" from the removal step) — `cleared:false` still
// holds and the victim is still untouched, so ONLY the two reason assertions
// fire. That is the measured hollowness, reproduced.
// SECOND SABOTAGE: resolve and remove "whatever is at latchPath now" at
// removal time without re-confirming it is the same object that passed
// verification — `result.cleared` flips true without the original incident
// ever having been genuinely resolved.
// ===========================================================================
test('AC-R16: a symlink swapped in at the latch path between verification and removal aborts — victim file untouched, no false success', { skip: BEHAVIOURAL_SKIP || SYMLINK_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir); // starts as a normal, valid latch — passes verification
    writeBaseline(dir, exactBaselineFor(dir)); // exact — verification alone would succeed (AC-R1)

    const victimPath = join(dir, 'VICTIM.txt');
    const victimBytes = Buffer.from('DO NOT TOUCH — planted by AC-R16, outside the (B) surface\n');
    writeFileSync(victimPath, victimBytes);

    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookAfterEnumeration: async () => {
        rmSync(latchPath(dir), { force: true });
        symlinkSync(victimPath, latchPath(dir));
      },
    });

    assert.notEqual(result.cleared, true, 'a mid-flight shape swap must never be reported as a successful, genuine clear');
    assert.match(
      reasonOf(result),
      REASON.midFlightSwap,
      `THE PIN: the verdict must be attributed to the latch CHANGING BETWEEN VERIFICATION AND REMOVAL — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(
      reasonOf(result),
      REASON.latchAbnormalShape,
      'THE DISCRIMINATOR: AC-R14 already pins the PRE-EXISTING abnormal shape. If this fixture resolves to that same wording, this test is measuring AC-R14\'s guard and contributes nothing of its own — which is exactly what the verifier found'
    );
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch was present and verified; a no-latch verdict here would mean the swap went unnoticed');
    // SAFETY NET ONLY — deliberately last, deliberately not the pin. unlinkSync
    // removes the link, never its target, so this cannot fail for the reason
    // the original comment claimed. Kept because it is free.
    assert.deepEqual(readFileSync(victimPath), victimBytes, 'safety net: the victim file is untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R17 — THE REMOVAL ITSELF FAILS (verification succeeds — identical
// fixture to AC-R1's control — but the actual unlink is denied by a read-only
// parent directory). Item 5: "if verification OR the removal itself fails,
// the latch stays and it fails loudly." Accepts EITHER a resolved
// {cleared:false} or a rejection — the calling convention for a genuinely
// unexpected I/O failure is left to the implementer; the durable effect
// (latch survives, byte-identical) is what this pin is actually about.
//
// SABOTAGE: swallow the unlink error and report success anyway (claiming a
// clear that never happened) — the latch-survives assertion fires; or throw
// away the original latch bytes attempting some destructive workaround (e.g.
// truncate-then-retry) — the byte-identity assertion fires.
// ===========================================================================
test('AC-R17: a removal that itself fails (read-only parent) leaves the latch byte-identical and never claims success', { skip: BEHAVIOURAL_SKIP || DIR_WRITE_DENY_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  const sterlingDir = join(dir, '.sterling');
  try {
    plantLatch(dir);
    const before = readFileSync(latchPath(dir));
    writeBaseline(dir, exactBaselineFor(dir)); // exact — verification alone would succeed (AC-R1)

    chmodSync(sterlingDir, 0o555); // deny the unlink itself (directory write permission)

    let result;
    let threw = null;
    try {
      result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    } catch (e) {
      threw = e;
    }

    if (threw) {
      // NOT a free pass: "fails loudly" means the failure NAMES itself. A
      // rejection carrying an empty/opaque message is not loud, it is just a
      // crash, so the rejection arm carries the same attribution burden as the
      // resolution arm.
      assert.match(
        oneLine(threw && (threw.message || String(threw))),
        REASON.removalFailed,
        `a rejection is an acceptable "fails loudly" shape only if it names the failed REMOVAL — got: ${oneLine(threw && (threw.message || String(threw)))}`
      );
    } else {
      assert.notEqual(result.cleared, true, 'a failed removal must never be reported as a successful clear');
      assert.match(reasonOf(result), REASON.removalFailed, `the verdict is attributed to the REMOVAL failing, not to a verification guard (verification succeeded here — identical fixture to AC-R1) — reason: ${reasonOf(result)}`);
      assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-latch verdict would misreport a denied unlink as nothing-to-do');
    }

    chmodSync(sterlingDir, 0o755); // restore access so the byte-identity check below can read the file
    assert.deepEqual(readFileSync(latchPath(dir)), before, 'THE RULING: a failed removal leaves the latch byte-identical — no destructive workaround was attempted');
  } finally {
    try {
      chmodSync(sterlingDir, 0o755);
    } catch {}
    cleanup();
  }
});

// ===========================================================================
// AC-R18 — POST-VERDICT MUTATION, THE SIMPLE FACE (the LADDER STEP for AC-R19,
// placed first on purpose). The (B) surface is tampered AFTER the final
// verification verdict and BEFORE the removal walk starts — the window that
// `_testHookAfterEnumeration` structurally cannot reach, because it fires
// before the final pass, not after it.
//
// This is the WEAKER of the two post-verdict pins: any honest re-check
// immediately before removal catches it, because the tampered surface no
// longer agrees with the (untouched) baseline. Its diagnostic value is entirely
// in the pairing — if AC-R18 passes and AC-R19 fails, the implementation has a
// post-verdict re-check but it is only SELF-CONSISTENCY, not a verdict bound
// to the bytes it was computed from. That is precisely the CRITICAL.
//
// EXPECTED: the seam exists now, so `hookCalls` should be 1. A `hookCalls`
// failure means SEAM 2 regressed — nothing was tampered — and the verdict must
// NOT be read as a statement about the guard.
//
// SABOTAGE: drop the pre-removal re-verification (or let the seam fire and
// ignore its effect) — `result.cleared` flips true and the latch disappears.
// ===========================================================================
test('AC-R18: a (B) surface tamper AFTER the final verdict and BEFORE the removal walk must not clear', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // exact — AC-R1 proves this fixture otherwise clears

    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeRemoval: async () => {
        hookCalls += 1;
        writeFileSync(coderPath(dir), '# TAMPERED after the final verdict, before the removal walk\n');
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 2 CONTRACT: _testHookBeforeRemoval must exist and be awaited EXACTLY ONCE, after the final verdict and before the first removal syscall (see the header). No seam = no way to pin this window at all');
    assert.notEqual(result.cleared, true, `a post-verdict tamper must never be reported as a genuine clear — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.changed, `the verdict must be attributed to the surface CHANGING after it was computed — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict tamper');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R19 — THE CRITICAL. POST-VERDICT SELF-CONSISTENT SUBSTITUTION.
//
// Found by outside-model review; provably invisible to AC-R8/AC-R52 (the
// baseline's own TOCTOU pin, dissolved-and-replaced per fe861066 — see the
// note where AC-R9 used to be), which is why it needs its own seam: the
// module re-reads the baseline, re-enumerates the
// surface and recomputes the verdict — and then RELEASES every pin and
// descriptor from those checks before starting a FRESH latch-removal walk.
// Nothing binds the baseline or the surface across that interval, and
// `removeLatch()` validates only the LATCH's own identity. So an attacker who
// wins that window substitutes TAMPERED (B) bytes TOGETHER WITH A MATCHING
// ATTACKER BASELINE: the pair is self-consistent, the latch is untouched and
// still identical, the unlink proceeds, and the call returns cleared:true.
// Call N+1 then sees no latch and a surface that agrees with its own baseline.
// (A Linux file lease on the latch makes the window deterministic in the real
// attack; this test does not need that mechanism, only the seam.)
//
// WHY AC-R18 DOES NOT COVER IT: a fix that simply repeats the verification
// after the verdict PASSES AC-R18 and STILL FAILS HERE, because there is
// nothing left to disagree with. Closing this requires the verdict to be BOUND
// to the exact bytes and identities it was computed from — carry the baseline's
// own content hash plus each (B) leaf's dev/ino/size/mtime/hash from the
// verdict into the removal step and re-confirm them, or hold descriptors open
// across removal. Re-running the same check is not a fix.
//
// EXPECTED: the seam exists now. RED with `cleared:true` means the verdict is
// not bound to the bytes it was computed from — the CRITICAL, reproduced. RED
// on `hookCalls` means SEAM 2 regressed, which is a different finding.
//
// SABOTAGE: replace the bound-identity re-confirmation with
// a plain repeat of the verification (re-read baseline, re-hash surface, compare)
// — AC-R18 stays green, THIS test flips to cleared:true. That divergence is
// the whole reason both tests exist.
// ===========================================================================
test('AC-R19 CRITICAL: a post-verdict tamper accompanied by a MATCHING attacker baseline (self-consistent) must not clear — the verdict must be bound to the bytes it was computed from', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // good baseline + good surface for BOTH verification passes

    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeRemoval: async () => {
        hookCalls += 1;
        // The exploit, in two lines: tamper the surface, then baseline the
        // tampered bytes. Everything on disk now agrees with everything else.
        writeFileSync(coderPath(dir), '# TAMPERED — attacker bytes substituted after the final verdict\n');
        writeBaseline(dir, exactBaselineFor(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 2 CONTRACT: _testHookBeforeRemoval must exist and be awaited EXACTLY ONCE after the final verdict — without it this CRITICAL is unpinnable, which is how it survived a 17/17 green suite');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: a self-consistent substitution performed after the verdict must NOT clear. Clearing here means the latch was discharged for bytes nobody ever verified, and call N+1 accepts the tampered enforcement surface — reason: ${reasonOf(result)}`
    );
    assert.match(
      reasonOf(result),
      REASON.changed,
      `the verdict must be attributed to the attested state CHANGING since the verdict was computed — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(
      reasonOf(result),
      REASON.ordinaryMismatch,
      'there is nothing to "mismatch" here — the surface and the baseline agree perfectly. A mismatch reason would mean the refusal came from somewhere other than the identity binding this test names'
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives — an incident is never discharged for unverified bytes');
    assert.match(readFileSync(coderPath(dir), 'utf8'), /TAMPERED/, 'sanity: the exploit actually landed on disk (a sabotage that fails to land looks exactly like a hollow test)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R20 — AN UNENUMERABLE (B) SUBDIRECTORY MUST REFUSE, NOT ENUMERATE AS
// EMPTY. The permission-denied face of the second race the outside review
// found, and the one that needs NO new seam — so this pin holds the guard even
// if AC-R21's seam is never built.
//
// THE ATTACK IT PINS: a tampered agent definition is hidden inside a
// `.claude/agents/**` subdirectory that the walk cannot enumerate. If the walk
// swallows the failure and treats the directory as EMPTY, the visible set is
// exactly the three attested paths, the baseline matches EXACTLY, and the latch
// is discharged while a tampered grant sits on disk inside it.
//
// ISOLATION: the baseline here is byte-identical to AC-R1's proven-success
// baseline, and the only difference from AC-R1's fixture is the unenumerable
// subdirectory — so a refusal cannot be explained by anything else, and a
// CLEAR is unambiguously the swallow-and-treat-as-empty bug.
//
// SABOTAGE: wrap the per-directory enumeration in `try { ... } catch { return
// [] }` — the hidden file becomes invisible, the set matches the baseline, and
// `result.cleared` flips true.
// ===========================================================================
test('AC-R20: a (B) subdirectory that cannot be enumerated REFUSES — it is never silently treated as empty', { skip: BEHAVIOURAL_SKIP || UNREADABLE_DIR_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  const hidden = join(dir, '.claude', 'agents', 'hidden');
  try {
    plantLatch(dir);
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'tampered.md'), '# a tampered agent grant, hidden where the walk cannot look\n');
    writeBaseline(dir, exactBaselineFor(dir)); // attests ONLY the three visible (B) paths
    chmodSync(hidden, 0o000);

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });

    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: an unenumerable (B) directory is an UNKNOWN surface, not an empty one — clearing here discharges the latch over bytes the walk never saw. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.enumerationFailed, `the verdict must be attributed to the ENUMERATION failing, and must name the directory — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), /hidden/, 'the refusal names the directory it could not enumerate');
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would misreport an unknown surface as nothing-to-do');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an unenumerable-surface refusal');
  } finally {
    try {
      chmodSync(hidden, 0o755);
    } catch {}
    cleanup();
  }
});

// ===========================================================================
// AC-R21 — A (B) SUBDIRECTORY THAT VANISHES BETWEEN readdir AND open MUST
// REFUSE. The ENOENT face of AC-R20's guard, and the exact shape the outside
// review named: a directory listed by `readdirSync` that is gone by the time
// the walk opens it is currently swallowed and enumerated as EMPTY, so a
// populated agents subdirectory can be renamed out across both enumeration
// passes and restored afterwards.
//
// REQUIRES SEAM 3 (`_testHookBeforeDirectoryOpen`, contract in the header).
// This one is NOT deterministically constructible without a seam: the window
// is between the parent's readdir and the child's open, entirely inside the
// walk. AC-R20 pins the same guard through its EACCES face without a seam, so
// if the conductor decides SEAM 3 is not worth the implementation surface,
// striking THIS TEST leaves the guard class pinned and only the ENOENT branch
// unpinned. That is a deliberate, disclosed tradeoff, not an oversight.
//
// EXPECTED: the seam exists now, so `vanished` should be true. If it is false
// the directory was never renamed out, `.claude/agents/hidden/tampered.md` is
// enumerated normally, and the call refuses as an INCOMPLETE baseline — the
// seam-fired assertion catches exactly that and names the missing seam rather
// than letting an accidental refusal read as a pass.
//
// SABOTAGE: treat an ENOENT from the directory open as an empty listing — the
// vanished directory's contents disappear from the set, the baseline matches
// exactly, and `result.cleared` flips true.
// ===========================================================================
test('AC-R21: a (B) subdirectory that vanishes between readdir and open REFUSES — it is never silently treated as empty', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const hidden = join(dir, '.claude', 'agents', 'hidden');
    const stash = join(dir, '.hidden-stash');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'tampered.md'), '# a tampered agent grant, renamed out mid-enumeration\n');
    writeBaseline(dir, exactBaselineFor(dir)); // attests ONLY the three visible (B) paths

    const seen = [];
    let vanished = false;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeDirectoryOpen: async (rel) => {
        seen.push(rel);
        if (!vanished && String(rel).endsWith('.claude/agents/hidden')) {
          vanished = true;
          renameSync(hidden, stash); // gone before the walk can open it
        }
      },
    });

    assert.equal(
      vanished,
      true,
      `SEAM 3 CONTRACT: _testHookBeforeDirectoryOpen must exist and fire with the repo-relative POSIX path of each discovered (B) subdirectory immediately before it is opened — it never fired for '.claude/agents/hidden'. Paths it did see: ${JSON.stringify(seen)}`
    );
    for (const rel of seen) {
      assert.doesNotMatch(String(rel), /\\/, `PATH INVARIANT: the seam receives forward-slash repo-relative paths, never backslashes — got ${rel}`);
    }
    assert.notEqual(result.cleared, true, `THE RULING: a directory that disappears mid-enumeration leaves the surface UNKNOWN — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.directoryVanished, `the verdict must be attributed to the directory VANISHING during enumeration — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a vanished-directory refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R22/AC-R23 DISSOLVED. The old pair pinned a per-entry `deleted:true`
// attestation (a path observed deleted stays clearable while absent; the same
// path reappearing on disk refuses). Decision fe861066 D1 fixes the list's
// entry shape as strictly `{path, sha256}` — no `deleted` field, no `at`
// field — so there is no way to attest a deletion at all under the new
// design: a path that no longer exists on disk simply has NO entry, and a
// list still carrying an entry for it is the ordinary STALE-ENTRY case
// AC-R7 already pins. Keeping either test would mean asserting on a field the
// concrete design does not define — an invented interface, not a spec-derived
// one — so both are removed rather than reworked. AC-R7 alone now carries
// the "list must not claim a path that is gone" direction.
// ===========================================================================

// ===========================================================================
// AC-R24 — THE IDENTITY GATE FAILS CLOSED ON OMISSION. Conductor ruling
// (S4r): the caller must make an EXPLICIT POSITIVE conductor assertion;
// ABSENCE IS NOT EVIDENCE OF CONDUCTOR.
//
// This is a DELIBERATE CONTRACT CHANGE and this test is EXPECTED RED against
// the current implementation, which treats an omitted `callerAgentId` as the
// conductor and therefore clears this fixture. Do not soften it to stay green.
//
// WHY IT IS THE HIGHEST-SEVERITY PIN IN THIS FILE: there is no MCP wrapper and
// no production caller in the repo yet, so TODAY every clearance path runs
// with the identity argument simply absent. A wrapper that forgets to thread
// `agent_id` — or that receives `undefined` from a hook payload — hands every
// spawned agent the ability to discharge the latch, and the rest of the
// protocol offers no second line of defence, because a baseline matching current
// disk is otherwise sufficient to clear.
//
// ISOLATION AND CONTROL: the fixture is byte-identical to AC-R1's
// proven-success fixture — exact baseline, real latch — with the conductor
// assertion as the SINGLE removed variable. AC-R1 therefore acts as this
// test's control: since that exact fixture clears WITH the assertion, a
// refusal here can only be the omission gate. The reason assertions carry the
// rest: the verdict must name the MISSING assertion, must not read as AC-R10's
// "an agent presented itself", and must not read as any baseline-family refusal
// (there is nothing wrong with the baseline).
//
// SABOTAGE: restore the old default — treat an absent/undefined identity as
// the conductor — `result.cleared` flips true and the latch disappears.
// SECOND SABOTAGE: accept any truthy `callerRole` (e.g. `if (callerRole)`)
// rather than the exact string — the third arm below, which passes
// `callerRole: 'agent'`, flips to cleared.
// ===========================================================================
test('AC-R24: an OMITTED conductor assertion REFUSES — absence is not evidence of conductor (fail-closed identity gate)', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ARM 1 — the argument is omitted entirely (today's every-production-caller
  // shape).
  {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's exact proven-success fixture

      const result = await reconcileEnforcementTaint({ cwd: dir });
      assert.equal(
        result.cleared,
        false,
        `THE RULING: an omitted conductor assertion must REFUSE. Clearing here means every caller that simply forgets the argument — which is every caller in the repo today — silently holds the conductor-only privilege. reason: ${reasonOf(result)}`
      );
      assert.match(reasonOf(result), REASON.missingConductorAssertion, `the verdict must name the MISSING conductor assertion — reason: ${reasonOf(result)}`);
      assert.doesNotMatch(reasonOf(result), REASON.baseline, 'the baseline is exact here; a baseline-family reason would mean this refusal came from somewhere other than the identity gate');
      assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op reason would mean the gate never fired');
      assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an unidentified call');
    } finally {
      cleanup();
    }
  }

  // ARM 2 — the argument is present but explicitly nullish. `undefined` is the
  // shape a hook payload produces for a field nobody set, and it must not be
  // luckier than omission.
  for (const bad of [undefined, null, '']) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));

      const result = await reconcileEnforcementTaint({ cwd: dir, callerRole: bad });
      assert.equal(result.cleared, false, `callerRole=${JSON.stringify(bad)} is not an assertion of conductorhood — reason: ${reasonOf(result)}`);
      assert.equal(existsSync(latchPath(dir)), true, `the latch survives callerRole=${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }

  // ARM 3 — a NON-CONDUCTOR role is not accepted merely for being truthy. This
  // is the arm that catches `if (callerRole)` instead of an exact comparison.
  for (const bad of ['agent', 'Conductor', 'conductor ', 'subagent', true, 1]) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));

      const result = await reconcileEnforcementTaint({ cwd: dir, callerRole: bad });
      assert.equal(
        result.cleared,
        false,
        `only the exact string 'conductor' asserts conductorhood; callerRole=${JSON.stringify(bad)} must refuse — reason: ${reasonOf(result)}`
      );
      assert.equal(existsSync(latchPath(dir)), true, `the latch survives callerRole=${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }
});

// ###########################################################################
// S4r MUTATION-REPAIR PASS — AC-R25 .. AC-R47. ONE numbered sequence; no id
// names two tests.
//
// LANE-COLLISION RESOLUTION (recorded here so nobody re-litigates it as an
// oversight). Two test-authoring lanes appended to this file concurrently and
// BOTH numbered their pins from AC-R25, so every citation of "AC-R27" named two
// different tests. The lanes disagreed on ONE substantive question — which seam
// a binding tamper must be injected at — and that question is now SETTLED by
// the coder against the CODE, not against the article (whose sequence prose is
// stale and is being reconciled separately): `_testHookBeforeRemoval` (SEAM 2)
// fires AFTER the second re-read/re-enumeration pass, exactly as SEAM 2's
// contract in the header says. Therefore:
//   * SEAM 2 AND SEAM 4 ARE ADJACENT WINDOWS, both after the last verification.
//     The two lanes were writing THE SAME PINS at two points a few instructions
//     apart — genuine duplicates, not a live set and a hollow set. Keeping both
//     would have doubled the ids while pinning one thing, so one survives per
//     property and the stronger CONSTRUCTION is the one kept.
//   * NEITHER LANE HAD THE WINDOW THAT ACTUALLY DISCRIMINATES. The module runs
//     `confirmBoundRoots`/`confirmBoundEdges` at BOTH the first and the last
//     position inside `confirmBoundEvidence`; a tamper at SEAM 2 or SEAM 4 is
//     caught by the FIRST position, so neither lane's namespace pin could see
//     the loss of the LAST-position re-check — the single edge whose loss
//     reopens the original attack in one move. `_testHookInsideConfirm`
//     (SEAM 4b) fires between the two positions and is now the seam for
//     AC-R30..AC-R34, and for the (a)-(d) pins as well, since it also removes
//     the root/edge check from their set of possible causes.
//   * Two pins from the second lane had NO counterpart here and survive,
//     re-pointed at SEAM 4b and renumbered: the member-DISAPPEARANCE arm
//     (AC-R46) and the baseline's IDENTITY arm (AC-R47).
//   * Its stronger FIXTURE CONSTRUCTIONS were folded into the surviving pins
//     rather than dropped: byte-identical rename substitution (AC-R26), the
//     same-inode fixture control (AC-R28), the dev/ino + decoy-bytes durable
//     assertions (AC-R29), and the WHICH-BOUND reason vocabulary (LIMIT +
//     DIMENSION) on every bound pin, AC-R39..AC-R45.
//   * NO COVERAGE WAS DROPPED TO RESOLVE A COLLISION. Where the two lanes wrote
//     the same pin, the stronger construction survives under one id.
//
// WHY THE WHOLE BLOCK EXISTS. An independent mutation-verification pass over
// the 24 pins above established that this module's suite pins almost nothing of
// what the clearer actually rests on (decision
// `the-clearer-is-a-tripwire-not-a-boundary-and-the-all-tool-latch-gate-is-
// what-makes-its-precondition-true`, 0ac7be95, R5): of the FOUR binding
// properties, only (a) was pinned; stripping (b), (c) or (d) each left the
// suite 24/24 GREEN, as did stripping `removeLatch`'s dev/ino re-confirmation
// and swapping the identity gate's two arms, and NO assertion existed about any
// of the enumeration/size bounds. R3 additionally records the namespace-
// rebinding CRITICAL and R4 rules that win32 must refuse rather than degrade.
//
// THIS BLOCK IS AUTHORED FROM THAT DECISION, NOT FROM THE IMPLEMENTATION (H4).
// It pins the CONTRACT R3 states, so the R3 pins (AC-R30..AC-R32, AC-R34) are
// EXPECTED RED until the rebinding fix lands. Do not soften them to reach
// green.
//
// THE SEQUENCE: AC-R25 seam control · AC-R26..AC-R28 + AC-R46/AC-R47 the four
// binding properties · AC-R29 the latch's own dev/ino · AC-R30..AC-R34 the R3
// namespace rebinding (AC-R33 is a control) · AC-R35/AC-R36 R4 win32 ·
// AC-R37 R6 synchrony · AC-R38 identity-arm ordering · AC-R39..AC-R45 the seven
// enumeration and size bounds · AC-R48 the unrecognised-seam refusal, which is
// the guard that keeps every seam-using pin above from going hollow on a typo.
//
// APPENDED BY THE PRE-COMMIT REPAIR PASS (see the AC-R49 block at the end of
// this file): AC-R49 the PROJECT-ROOT anchor, which is the only pin that
// exercises `confirmBoundRoots` at all · AC-R50 SEAM 4b's PLACEMENT below the
// first-position root/edge check, which is the premise AC-R26..AC-R34,
// AC-R46/R47 and AC-R49 all silently rest on · AC-R51 the inherited /
// non-enumerable / wrong-type extensions of AC-R48's seam-validation guard.
// ###########################################################################

// ===========================================================================
// AC-R25 CONTROL — BOTH CONFIRM SEAMS EXIST, FIRE EXACTLY ONCE, FIRE IN THAT
// ORDER, AND NO-OP HOOKS STILL CLEAR. PLACED FIRST, and it is the control every
// SEAM-4 / SEAM-4b pin below depends on. Without it, each of those refusals has
// TWO possible causes — "the guard I named fired" and "supplying this seam
// breaks the call / makes the module refuse unconditionally" — and a green
// suite could not tell them apart. This arm must pass for the OPPOSITE reason
// to all of them.
//
// IT ALSO PINS THE ORDER, which is not decoration: every pin below is written
// against a specific claim about WHERE its tamper lands relative to the
// first-position root/edge check. If the two seams ever fired in the other
// order, those pins would be injecting into a window they do not describe, and
// nothing else in this file would notice.
//
// It also pins SEAM 4's ARGUMENT contract, which AC-R37 (R6) consumes.
//
// EXPECTED FAILURE SHAPE: both seams exist now, so this should be GREEN. RED on
// either `calls` assertion means that seam regressed, and EVERY pin using it
// must be re-read as "injected nothing" rather than as a real verdict — an
// unknown/misspelled `_test*` property is refused by name rather than silently
// dropped, so a typo shows up here as a refusal, not as a vacuous pass.
//
// SABOTAGE: make the module refuse whenever `_testHookBeforeConfirm` is
// supplied (the "make the tests pass by refusing" shortcut) — `result.cleared`
// stays false and the clears assertion fires, so the shortcut cannot buy a
// green suite. SECOND SABOTAGE: move `_testHookInsideConfirm` to fire before
// `_testHookBeforeConfirm` — only the ordering assertion moves, and it is the
// one that keeps AC-R30..AC-R34 meaning what they say.
// ===========================================================================
test('AC-R25 CONTROL: SEAM 4 and SEAM 4b each fire exactly once, in that order, with the bound-confirmation callback, and no-op hooks still CLEAR', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture, untouched

    let calls = 0;
    let insideCalls = 0;
    let received = 'SEAM-NEVER-FIRED';
    let orderWitness = [];
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeConfirm: (confirmFn) => {
        calls += 1;
        received = confirmFn;
        orderWitness.push('before');
      },
      // SYNCHRONOUS AND RETURNS UNDEFINED ON PURPOSE — this seam is CALLED, NOT
      // AWAITED, and a thenable return REFUSES.
      _testHookInsideConfirm: () => {
        insideCalls += 1;
        orderWitness.push('inside');
      },
    });

    assert.equal(
      calls,
      1,
      'SEAM 4 CONTRACT: _testHookBeforeConfirm must exist and be awaited EXACTLY ONCE, after the latch dev/ino re-confirmation and immediately before confirmBoundEvidence is entered (see the header). Without this seam, properties (b), (c) and (d) of the evidence binding CANNOT BE PINNED AT ALL — which is exactly how all three stayed live-but-unpinned through a 24/24 green suite'
    );
    assert.equal(
      insideCalls,
      1,
      'SEAM 4b CONTRACT: _testHookInsideConfirm must exist and fire EXACTLY ONCE, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. It is the ONLY window from which the LAST-POSITION root/edge re-check can be pinned, because a tamper injected anywhere earlier is caught by the first position and the pin cannot discriminate the two'
    );
    assert.deepEqual(
      orderWitness,
      ['before', 'inside'],
      `SEAM ORDERING CONTRACT: _testHookBeforeConfirm fires BEFORE confirmBoundEvidence is entered and _testHookInsideConfirm fires INSIDE it, so this order is structural. If it ever inverts, every pin below is injecting its tamper in a window it does not describe — got ${JSON.stringify(orderWitness)}`
    );
    assert.equal(typeof received, 'function', 'SEAM 4 CONTRACT: the seam receives the exact callback that will run as the pre-unlink bound confirmation — AC-R37 inspects that value');
    assert.equal(result.cleared, true, `CONTROL: supplying BOTH seams must not change the verdict — this fixture clears (AC-R1) and must still clear. reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: the latch is genuinely removed on the untampered path, so every refusal below is caused by its tamper and not by the seam');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R26 — BINDING PROPERTY (b): RENAME-SUBSTITUTION OF A (B) LEAF, CAUGHT
// ONLY BY `lstat` OF THE LEAF NAME THROUGH THE RETAINED PINNED PARENT.
//
// Measured live-but-unpinned (0ac7be95 R5): stripping (b) left the suite green.
//
// WHY ONLY (b) CAN SEE THIS, which is what makes the pin non-hollow:
//   * (a) re-hashing the RETAINED DESCRIPTOR is structurally blind — the fd
//     still holds the ORIGINAL inode, whose bytes are unchanged. The article's
//     own words: "(a) structurally CANNOT see it".
//   * (c) directory-membership re-listing is blind — the name `coder.md` is
//     still present in `.claude/agents`, so the (B)-relevant name set is
//     IDENTICAL before and after.
//   * (d) the baseline is untouched.
//   * The R3 directory-edge checks are blind TWICE OVER — no directory's
//     identity moved, AND the tamper is injected at SEAM 4b, which is AFTER the
//     first-position `confirmBoundRoots`/`confirmBoundEdges` has already run.
//     That is the point of using this seam for a LEAF pin: it removes the
//     root/edge check from the set of possible causes entirely, rather than
//     arguing from the fixture that it could not have fired.
//   * No verification pass of any kind follows SEAM 4b, so the ordinary
//     re-read/re-hash machinery (which WOULD catch a different-bytes tamper)
//     never runs.
// The tampered replacement is staged in `staging/` at FIXTURE time and moved
// with a single `renameSync`, so the substitution perturbs NO name set the
// walk could be watching — not `.claude/agents` (the name is reused) and not
// the repo root (nothing is created or removed there during the call).
//
// THE SUBSTITUTE IS BYTE-IDENTICAL, WHICH IS THE STRONGER OF THE TWO POSSIBLE
// FIXTURES AND THE ONE THIS PIN USES. A substitute with DIFFERENT bytes is also
// invisible to (a) as the module is described — but it stops being invisible
// the moment anyone re-hashes BY PATH rather than through the retained fd,
// which is the single most natural way to write (a) wrongly and would silently
// move the verdict onto a guard this test does not name. Byte-identical bytes
// close that door: no content check of any kind, through any descriptor, can
// see this tamper. The two FIXTURE-CONTROL assertions below prove the
// construction actually held ON THIS HOST rather than asserting it in a
// comment.
//
// EXPECTED FAILURE SHAPE: the seam exists now, so `hookCalls` should be 1. If
// (b) is absent or is re-anchored to post-mutation state, the retained fd still
// hashes to the verdict's sha256, everything else agrees, and the call CLEARS
// -> the `cleared` and `existsSync` assertions fire. A `hookCalls` failure here
// means the seam regressed, not that (b) did.
//
// SABOTAGE (one line): delete the `lstat(retained-parent-fd, name)` dev/ino
// comparison from `confirmBoundEvidence`, keeping (a) and (c) — the call
// returns cleared:true and the latch is discharged for a file the live tree no
// longer reaches. Nothing else in this suite notices.
// ===========================================================================
test('AC-R26: a (B) leaf RENAME-SUBSTITUTED (byte-identical) after the final verdict must not clear — no content check of any kind can see this, only lstat through the retained parent', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture

    // Staged BEFORE the call, and OUTSIDE the (B) surface: creating this file
    // during the call would perturb a name set and hand the verdict to property
    // (c) instead, which is precisely the substitution that makes a pin hollow.
    const staging = makeStaging(dir);
    const substitute = join(staging, 'coder-substitute.md');
    const originalBytes = readFileSync(coderPath(dir));
    writeFileSync(substitute, originalBytes); // BYTE-IDENTICAL, different inode

    let hookCalls = 0;
    let idBefore = null;
    let idAfter = null;
    let bytesAfter = null;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        idBefore = identityOf(coderPath(dir));
        renameSync(substitute, coderPath(dir)); // atomic swap of the NAME, not the bytes of the retained fd
        idAfter = identityOf(coderPath(dir));
        bytesAfter = readFileSync(coderPath(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    // ---- FIXTURE CONTROLS: prove the construction that makes every content
    // check blind. Without them a green could mean "nothing actually moved".
    assert.notEqual(idAfter, idBefore, `FIXTURE CONTROL: the substitution must actually change dev/ino, or this test pins nothing about identity (before=${idBefore} after=${idAfter})`);
    assert.deepEqual(
      bytesAfter,
      originalBytes,
      'FIXTURE CONTROL: the substituted bytes are IDENTICAL. That is what makes every content check — (a) through the retained fd, or a re-hash by path — structurally blind, so a refusal is attributable to property (b) and to nothing else'
    );
    // ---- THE PIN.
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R5, property (b)): the verdict authorised removal for a specific set of INODES, and a leaf whose NAME now reaches a different object is not one of them. An attacker holding a write descriptor to the substituted inode rewrites its bytes the instant the latch is gone, with no denial left to re-mint the incident. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict rename-substitution');
    assert.match(
      reasonOf(result),
      /coder\.md/,
      `the refusal NAMES the substituted leaf — an accidental TypeError swallowed by the outer catch cannot do that, and an unattributable {cleared:false} is exactly what made AC-R16 hollow. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to the IDENTITY of the leaf, not to its content — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'nothing "mismatches" here — the bytes and the baseline agree perfectly. A mismatch reason would mean the refusal came from somewhere other than the identity binding');
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would mean the binding never ran');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R27 — BINDING PROPERTY (c): DIRECTORY-MEMBERSHIP RE-LISTING OF THE
// RETAINED DIRECTORY DESCRIPTORS.
//
// Measured live-but-unpinned (0ac7be95 R5): stripping (c) left the suite green.
//
// THE TAMPER IS A NEW MEMBER APPEARING, chosen deliberately: (a) and (b) are
// PER-MEMBER guards over the leaves the verdict already knows about, so both
// are structurally blind to a member that was never in the verdict. (d) is the
// baseline. The R3 edge checks watch directory IDENTITIES, and `.claude/agents`
// keeps its identity here — only its CONTENTS change. So exactly one guard can
// see this, which is what stops the pin resolving to a sibling.
//
// WHAT IT DEFENDS: a tampered agent grant dropped into `.claude/agents` after
// the surface was verified. The latch is discharged, call N+1 baselines or accepts
// a surface containing a file nobody ever attested.
//
// EXPECTED FAILURE SHAPE: the seam exists now, so a `hookCalls` failure means
// the seam regressed rather than the property under test.
// Once the seam exists but (c) is absent, no guard sees `evil.md` and the call
// CLEARS -> the `cleared`/`existsSync` assertions fire.
//
// SABOTAGE (one line): delete the per-retained-directory re-listing from
// `confirmBoundEvidence` (keep (a), (b) and (d)) — cleared:true, and the file
// planted after the verdict is inside the surface the latch was discharged for.
// ===========================================================================
test('AC-R27: a NEW member appearing in a retained (B) directory after the final verdict must not clear — (a) and (b) are per-member blind, only the re-listing can see it', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture

    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        writeFileSync(join(dir, '.claude', 'agents', 'evil.md'), '# TAMPERED — an unattested agent grant added after the verdict\n');
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R5, property (c)): a directory that has gained a member since the verdict is not the directory that was verified. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict member appearing');
    assert.match(
      reasonOf(result),
      /agents|evil\.md/,
      `the refusal NAMES the directory whose membership changed (or the member that appeared) — an accidental catch-all cannot. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.membershipChanged, `the verdict is attributed to the MEMBERSHIP re-listing — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would mean the binding never ran');
    assert.equal(existsSync(join(dir, '.claude', 'agents', 'evil.md')), true, 'sanity: the tamper actually landed on disk');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R28 — BINDING PROPERTY (d): THE BASELINE'S OWN BOUND CONFIRMATION.
//
// Measured live-but-unpinned (0ac7be95 R5): stripping (d) left the suite green.
//
// The baseline is rewritten IN PLACE (`writeFileSync` truncates the SAME inode)
// after the final verdict, so the module's retained baseline descriptor is looking
// at bytes that no longer exist. Nothing else can see it: the baseline is not part
// of the (B) surface (AC-R1 clears with a baseline on disk and no entry attesting
// it), so (a), (b) and (c) never touch it, no directory identity moves, the
// first-position root/edge check has ALREADY RUN by the time SEAM 4b fires, and
// no verification pass of any kind follows it.
//
// WHY IT MATTERS: the baseline on disk is what call N+1 compares the surface
// against. Discharging the latch while the live manifest is somebody else's is
// the laundering shape this whole module exists to prevent — the verdict said
// "this surface is attested by THIS manifest", and that manifest is gone.
//
// EXPECTED FAILURE SHAPE: the seam exists now, so a `hookCalls` failure means
// the seam regressed rather than the property under test. If (d) is absent, the
// module clears against a baseline it never re-confirmed -> the
// `cleared`/`existsSync` assertions fire.
//
// SABOTAGE (one line): drop the baseline re-confirmation from
// `confirmBoundEvidence` (keep (a), (b), (c)) — cleared:true.
// ===========================================================================
test('AC-R28: the BASELINE rewritten in place after the final verdict must not clear — the retained baseline descriptor must be re-confirmed against the verdict', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture

    let hookCalls = 0;
    let baselineIdBefore = null;
    let baselineIdAfter = null;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        baselineIdBefore = identityOf(baselinePath(dir));
        // Truncate-in-place on the same inode: the retained descriptor cannot
        // see this unless it is actually re-read.
        writeBaseline(dir, [{ path: CODER_REL, sha256: 'deadbeef' }]);
        baselineIdAfter = identityOf(baselinePath(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.equal(
      baselineIdAfter,
      baselineIdBefore,
      `FIXTURE CONTROL: this arm must be a TRUNCATE-IN-PLACE (same inode, new bytes), which is what isolates the CONTENT half of property (d) from the IDENTITY half AC-R47 pins. If the inode moved, this test is measuring AC-R47's guard (before=${baselineIdBefore} after=${baselineIdAfter})`
    );
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R5, property (d)): the manifest the verdict rests on must still be the manifest on disk at the instant the latch is discharged. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict baseline rewrite');
    assert.match(reasonOf(result), REASON.baseline, `the refusal NAMES the baseline — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.changed, `the verdict is attributed to the baseline CHANGING since it was read, not to a fresh disagreement — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would mean the binding never ran');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R29 — `removeLatch`'s dev/ino RE-CONFIRMATION. TODAY A REGULAR-FILE ->
// REGULAR-FILE SWAP IS CAUGHT BY NOTHING (0ac7be95 R5, verbatim).
//
// AC-R16 already pins the regular -> SYMLINK swap, but the verifier established
// that O_NOFOLLOW carries that verdict, so the dev/ino comparison itself is
// unpinned. A regular file swapped for a DIFFERENT REGULAR FILE passes every
// kind check there is; only the retained dev/ino can tell them apart.
//
// WHY IT MATTERS: the module's ONLY mutation is `unlinkSync` on the latch leaf.
// Without the dev/ino comparison it unlinks whatever regular file now sits at
// that name — an attacker-planted file, or (with a rename race on `.sterling`)
// something else entirely — and reports the incident as discharged although the
// latch it verified was never the object removed.
//
// SEAM 2 IS THE RIGHT SEAM HERE, not SEAM 4: the swap must happen BEFORE the
// latch is re-classified, and the latch is not part of the (B) surface or the
// baseline, so no verification pass can see it either way — the guard under test
// is the only thing that can.
//
// The removed/recreated name keeps `.sterling`'s name set identical, so a
// membership re-listing cannot be the guard that carries this verdict.
//
// EXPECTED FAILURE SHAPE: RED only if the dev/ino re-confirmation is absent or
// compares something weaker (e.g. path + kind). Expected GREEN today if the
// bigint dev/ino comparison the article describes is really live — this pin
// makes that property regression-visible, which it currently is not.
//
// SABOTAGE (one line): delete the retained-dev/ino comparison from
// `removeLatch`'s re-classification, keeping the is-regular-file kind check —
// the substituted file is unlinked, `result.cleared` flips true, and the
// "substitute survives" assertion fires as well.
// ===========================================================================
test('AC-R29: the latch swapped for a DIFFERENT REGULAR FILE between verification and removal must not clear — the kind check cannot see this, only the retained dev/ino can', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // exact — verification alone would succeed (AC-R1)

    // Staged in `src/` (outside `.sterling`) and moved in with ONE rename, so
    // `.sterling`'s name set is identical before and after and a membership
    // re-listing can never be the guard that carries this verdict. An
    // unlink-then-create would open that ambiguity for no gain.
    const decoyBytes = Buffer.from(JSON.stringify({ decoy: true, note: 'an attacker inode swapped onto the latch name after verification' }));
    const decoySrc = join(dir, 'src', 'decoy-latch.json');
    writeFileSync(decoySrc, decoyBytes);

    let hookCalls = 0;
    let idBefore = null;
    let idAfter = null;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeRemoval: () => {
        hookCalls += 1;
        idBefore = identityOf(latchPath(dir));
        renameSync(decoySrc, latchPath(dir)); // same name, same KIND, different inode
        idAfter = identityOf(latchPath(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 2 CONTRACT: _testHookBeforeRemoval must fire exactly once before the first syscall of the removal walk (see the header)');
    // ---- FIXTURE CONTROLS: prove the construction that makes the KIND check
    // blind, so a green cannot mean "the swap never happened".
    assert.notEqual(idAfter, idBefore, `FIXTURE CONTROL: the swap must actually change dev/ino (before=${idBefore} after=${idAfter})`);
    assert.equal(
      lstatSync(latchPath(dir)).isFile(),
      true,
      'FIXTURE CONTROL: the object at the latch path is an ORDINARY REGULAR FILE — that is what makes the kind classification blind here, so only the dev/ino comparison can carry the verdict'
    );
    assert.notEqual(result.cleared, true, `THE RULING: a latch that is no longer the object that was verified must not be removed, even when the replacement is the same KIND. reason: ${reasonOf(result)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      'THE DURABLE PIN: the substituted file is still there — the module must never unlink an object it did not verify'
    );
    assert.deepEqual(
      readFileSync(latchPath(dir)),
      decoyBytes,
      'THE DURABLE EFFECT, AND THE ASSERTION THAT SURVIVES ANY WORDING DRIFT: the file at the latch path is the ATTACKER\'s, byte-identical and untouched — proof the unlink did not fire on an unverified inode'
    );
    assert.match(reasonOf(result), REASON.midFlightSwap, `the verdict is attributed to the latch changing BETWEEN VERIFICATION AND REMOVAL — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(
      reasonOf(result),
      REASON.latchAbnormalShape,
      'THE DISCRIMINATOR: nothing about the replacement is abnormally SHAPED — it is a plain regular file. An abnormal-shape reason would mean the kind check fired, which cannot be true, and would mean this pin is measuring AC-R13/AC-R14\'s guard'
    );
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'a file is present at the latch path; a no-op verdict would misreport the swap as nothing-to-do');
  } finally {
    cleanup();
  }
});

// ###########################################################################
// AC-R30 .. AC-R34 — R3, THE UNFIXED CRITICAL: RETAINED DIRECTORIES ARE NOT
// REBOUND TO THE LIVE NAMESPACE.
//
// 0ac7be95 R3, verbatim in substance: `pinChain` checks each directory
// component's identity ONLY AT ACQUISITION and does not retain the chain
// metadata for a second identity check, so the final directory checks prove the
// contents of the OLD DIRECTORY INODE, not that the live repository path still
// reaches it. THE FIX: retain, for EVERY DIRECTORY EDGE, the parent descriptor
// + child name + the child's dev/ino, and at confirmation require
// `lstat(parent-fd/name)` to still match the retained child — across
// root->`.claude`, `.claude`->`agents`, every recursive agents edge,
// root->`.sterling` (which the S4 baseline-list design, fe861066 D1, makes the
// edge directly containing the list — the old `.sterling`->`transient` edge
// dissolved along with the deleted stamp's location). For an ABSENT root,
// retain EXPECTED ABSENCE and require `lstat` to still return ENOENT.
//
// A RE-WALK BY NAME IS EXPLICITLY NOT THE FIX (0ac7be95 rejected it): the chain
// can be swapped during the re-walk, or the expected name briefly restored for
// the check and swapped again after. These tests therefore pin the OUTCOME (the
// substitution refuses), which the per-edge retention satisfies and which a
// name-re-walk satisfies only by luck — the tests cannot distinguish those two,
// and that limit is disclosed here rather than left implied.
//
// THESE FIVE PINS ARE EXPECTED RED UNTIL THE FIX LANDS (AC-R33 excepted — it is
// their CONTROL and must be green today). That is CORRECT. Do not soften them.
//
// EVERY SWAP IS STAGED AT FIXTURE TIME AND EXECUTED AS TWO `renameSync` CALLS
// so that no directory's NAME SET changes: the name that is swapped is present
// before and after, and `staging/` is created before the call starts. Without
// that care, a membership re-listing (property (c), AC-R27) could carry these
// verdicts and each pin would silently be measuring AC-R27's guard instead of
// R3's — the exact substitution defect that made AC-R16 hollow.
// ###########################################################################

// ===========================================================================
// AC-R30 — THE RENAME-ASIDE ATTACK ON THE root->`.claude` EDGE. 0ac7be95 R3's
// headline exploit: after the final verdict, rename `.claude` aside and install
// a NEW `.claude` holding tampered agent/settings files. Every retained
// descriptor resolves through the DETACHED verified tree, identities and hashes
// match, the baseline is untouched, and the latch is removed although the LIVE
// tree was never verified.
//
// WHY NO OTHER GUARD CAN SEE IT: (a) re-hashes retained descriptors — they
// point into the detached tree and still match. (b) lstats leaf names through
// the RETAINED PARENT fd — that fd IS the detached `.claude/agents`, so the
// names still resolve to the same inodes. (c) re-lists the RETAINED directory
// descriptors — same detached directories, same name sets. (d) the baseline is
// untouched. The repo root's own name set is unchanged (`.claude` present
// before and after; the aside copy lands inside the pre-created `staging/`).
//
// WHICH GUARD ACTUALLY CARRIES THIS VERDICT — CORRECTED, AND THE CORRECTION IS
// THE POINT. This comment used to claim AC-R30 was THE PIN ON
// `confirmBoundRoots`. IT IS NOT, AND THAT FALSE CLAIM IS EXACTLY HOW
// `confirmBoundRoots` SHIPPED ENTIRELY UNPINNED: a reader checking coverage saw
// a comment asserting the roots guard was covered and looked no further.
// MEASURED 2026-08-30: commenting out BOTH `confirmBoundRoots(roots);` call
// sites, leaving `confirmBoundEdges(edges);` fully live, left the suite 48/48
// GREEN — this test included. What this fixture renames is `.claude`, which is
// a directory EDGE (root-fd -> `.claude`), so `confirmBoundEdges` is what
// refuses here, and the same is true of AC-R31, AC-R32 and AC-R34. The PROJECT
// ROOT (`cwd`) itself — the only thing `confirmBoundRoots` uniquely proves — is
// moved by exactly one pin in this file, AC-R49, and by nothing else.
//
// WHAT AC-R30 DOES STILL PIN, WHICH IS REAL: the LAST POSITION of the edge
// re-check — the re-check review calls it "the single edge whose loss reopens
// the original attack in one move". The module runs the root/edge check at BOTH
// the FIRST and the LAST position inside `confirmBoundEvidence`. A rename
// injected at SEAM 2 or SEAM 4 is therefore caught by the FIRST position, and
// such a pin stays green with the last one deleted — it proves only that SOME
// position exists. THIS TEST INJECTS AT SEAM 4b, BETWEEN THE TWO POSITIONS, so
// the first position has already run and only the last can refuse. (That the
// seam really does sit BELOW the first position — the premise the whole
// paragraph rests on — is itself pinned only by AC-R50; without it, moving one
// seam call above the first-position check leaves AC-R30 green while it
// silently reverts to proving "some position exists".)
//
// MEASURED, so the discrimination is not merely argued (probe, this seam, this
// swap): unmutated -> `cleared:false` naming the dev/ino mismatch; LAST-position
// re-check commented out with the FIRST still live -> `cleared:true`; restored
// -> refuses again. A control arm on an untampered project cleared in all three
// runs. That is the pin doing exactly the one job it names.
//
// EXPECTED FAILURE SHAPE: the seams exist now, so `hookCalls` should be 1 and
// this pin should be GREEN. RED with `cleared:true` means the LAST-POSITION
// re-check is gone (the CRITICAL, reproduced); RED on `hookCalls` means the
// seam regressed, which is a different finding and must not be read as this
// one.
//
// SABOTAGE (one line): delete the LAST-POSITION `confirmBoundEdges(edges);`
// re-check — i.e. the root->`.claude` EDGE re-confirmation
// (`lstat(root-fd, '.claude')` compared against the retained dev/ino) that runs
// AFTER all verification and before the unlink. `result.cleared` flips true and
// the latch is discharged for a tree the module never read. NOTHING ELSE IN
// THIS FILE NOTICES: no other fixture substitutes the `.claude` edge between
// the two positions, and the whole reason the check must sit LAST is that a
// copy of it placed anywhere earlier is defeated by doing the rename one
// instruction later, which is exactly what this test's SEAM-4b injection does.
// NOTE WHICH GUARD THAT SABOTAGE NAMES: `confirmBoundEdges`, NOT
// `confirmBoundRoots`. Deleting BOTH `confirmBoundRoots(roots);` calls leaves
// this test GREEN (measured); AC-R49 is the pin that goes red for that one.
// ===========================================================================
test('AC-R30: `.claude` RENAMED ASIDE and replaced after the final verdict must not clear — retained descriptors prove the OLD inode, not that the live path still reaches it', { skip: BEHAVIOURAL_SKIP }, async () => {
  // The fixture builder, used TWICE: once by the per-fixture control (no-op
  // seam, must CLEAR) and once by the pin. AC-R25 controls the SEAM; this
  // controls THIS FIXTURE, which AC-R25's does not cover — it has a `staging/`
  // tree at the repo root that AC-R25's does not.
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    writeBaseline(p.dir, exactBaselineFor(p.dir)); // AC-R1's proven-success fixture
    // Staged at FIXTURE time so the repo root's name set never changes during
    // the call: `.claude` is present before and after; `staging/` too.
    const staging = makeStaging(p.dir);
    const newClaude = join(staging, 'claude-new');
    mkdirSync(join(newClaude, 'agents'), { recursive: true });
    writeFileSync(join(newClaude, 'agents', 'coder.md'), '# TAMPERED — the live tree nobody verified\n');
    writeFileSync(join(newClaude, 'settings.local.json'), JSON.stringify({ hooks: 'disabled' }) + '\n');
    return p;
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R30');

  const { dir, cleanup } = build();
  const staging = join(dir, 'staging');
  const newClaude = join(staging, 'claude-new');
  try {
    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        renameSync(join(dir, '.claude'), join(staging, 'claude-verified'));
        renameSync(newClaude, join(dir, '.claude'));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.notEqual(
      result.cleared,
      true,
      `THE CRITICAL (0ac7be95 R3): clearing here discharges the latch although the LIVE .claude tree was never verified — every retained descriptor is resolving through a detached, renamed-aside tree. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict namespace substitution of `.claude`');
    assert.match(
      reasonOf(result),
      /\.claude/,
      `the refusal NAMES the directory whose live binding broke — an unattributable refusal cannot be told apart from an accidental catch. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to the DIRECTORY being substituted — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would mean no edge check ran');
    assert.match(readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8'), /TAMPERED/, 'sanity: the substitution actually landed on the LIVE path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R31 — THE SAME ATTACK ONE EDGE DOWN: `.claude`->`agents`. 0ac7be95 R3
// requires the retention on EVERY directory edge, and an implementation that
// rebinds only the two roots would pass AC-R30 and AC-R32 while leaving this
// one open. That is precisely the "fixed the reported case" failure mode, so it
// gets its own pin rather than being assumed covered.
//
// ISOLATION: `.claude` keeps its identity (only its `agents` CHILD is swapped)
// and its name set is unchanged (`agents` present before and after), so
// AC-R30's edge check and AC-R27's membership re-listing are both blind. The
// retained `agents` descriptor still lists `coder.md` and still hashes to the
// verdict, so (a), (b) and (c) are blind too.
//
// INJECTED AT SEAM 4b, LIKE AC-R30, so the FIRST-position edge check has
// already run and only the LAST-position re-check can refuse.
//
// EXPECTED FAILURE SHAPE: RED with `cleared:true` while the recursive-edge
// retention is missing or is only re-confirmed at the first position. A
// `hookCalls` failure means the seam regressed, which is a different finding.
//
// SABOTAGE (one line): rebind only the (B) ROOTS and not the
// recursive edges — AC-R30 and AC-R32 stay green, THIS test flips to
// cleared:true. That divergence is why both exist.
// ===========================================================================
test('AC-R31: `.claude/agents` substituted after the final verdict must not clear — the per-EDGE retention must cover recursive edges, not just the (B) roots', { skip: BEHAVIOURAL_SKIP }, async () => {
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    writeBaseline(p.dir, exactBaselineFor(p.dir)); // AC-R1's proven-success fixture
    const staging = makeStaging(p.dir);
    const newAgents = join(staging, 'agents-new');
    mkdirSync(newAgents, { recursive: true });
    writeFileSync(join(newAgents, 'coder.md'), '# TAMPERED — a substituted agents directory\n');
    return p;
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R31');

  const { dir, cleanup } = build();
  const staging = join(dir, 'staging');
  const newAgents = join(staging, 'agents-new');
  try {
    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        renameSync(join(dir, '.claude', 'agents'), join(staging, 'agents-verified'));
        renameSync(newAgents, join(dir, '.claude', 'agents'));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R3, "every recursive agents edge"): a substituted intermediate directory is as fatal as a substituted root. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict substitution of `.claude/agents`');
    assert.match(reasonOf(result), /agents/, `the refusal NAMES the substituted directory — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to the DIRECTORY being substituted — reason: ${reasonOf(result)}`);
    assert.match(readFileSync(coderPath(dir), 'utf8'), /TAMPERED/, 'sanity: the substitution actually landed on the LIVE path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R32 — THE MANIFEST SWAP: root->`.sterling` SUBSTITUTED. REWORKED for the
// S4 baseline-list design (decision fe861066 D1): the list lives DIRECTLY at
// `.sterling/enforcement-baseline.json`, not under `.sterling/transient/` (the
// old stamp's location, deleted along with the stamp) — so the edge that
// launders the manifest is now root->`.sterling` itself, the same edge
// `.sterling/config.json` (a (B) member) and the latch also hang off. 0ac7be95
// R3's "the identical trick on .sterling/transient substitutes the manifest"
// carries over one level up rather than dissolving: whichever directory
// directly contains the list is the one that must be edge-bound, and for this
// design that directory is `.sterling`.
//
// FIXTURE CARE, absent from the pre-rework version: `.sterling` also holds the
// LATCH and `config.json` (a (B) member), so a naive substitution would
// perturb both. The replacement `.sterling` therefore carries a BYTE-IDENTICAL
// copy of the latch and of config.json (isolating this pin to the manifest
// binding alone, the same technique AC-R26 uses for a leaf) plus an ATTACKER
// baseline file — self-inconsistent garbage is fine, since no content check of
// the good baseline's own bytes is what this pin is about.
//
// THIS IS THE LAUNDERING SHAPE, and it is why the edge matters even though the
// baseline's own bytes are bound by property (d): (d) re-reads the RETAINED
// baseline DESCRIPTOR, which still holds the verified manifest inside the
// detached directory. The manifest the LIVE path now reaches — the one call
// N+1 will compare the surface against — is the attacker's, and the latch has
// been discharged. AC-R28 and this test therefore pin different guards on the
// same file: AC-R28 the bytes, this one the binding of the NAME to them.
//
// ISOLATION: the repo root's name set is unchanged (`.sterling` present before
// and after — the swap material lives in `staging/`), the retained baseline fd
// still reads the good manifest, and the copied latch/config.json bytes are
// byte-identical to the originals — so (a), (b), (d) and `removeLatch`'s own
// dev/ino check are all blind. Only the root->`.sterling` edge re-check can
// refuse.
//
// INJECTED AT SEAM 4b, LIKE AC-R30, so the FIRST-position edge check has
// already run and only the LAST-position re-check can refuse.
//
// EXPECTED FAILURE SHAPE: RED with `cleared:true` while the root->`.sterling`
// edge is unretained or only re-confirmed at the first position. A
// `hookCalls` failure means the seam regressed instead.
//
// SABOTAGE (one line): drop the root->`.sterling` edge re-confirmation —
// cleared:true, and call N+1 measures the surface against a manifest that was
// substituted after the verdict.
// ===========================================================================
test('AC-R32: `.sterling` substituted after the final verdict must not clear — the LIVE manifest, not the retained descriptor, is what call N+1 will trust', { skip: BEHAVIOURAL_SKIP }, async () => {
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    writeBaseline(p.dir, exactBaselineFor(p.dir)); // AC-R1's proven-success fixture
    const staging = makeStaging(p.dir);
    const newSterling = join(staging, 'sterling-new');
    mkdirSync(newSterling, { recursive: true });
    // BYTE-IDENTICAL copies of the latch and config.json — isolates this pin
    // to the manifest EDGE binding, exactly as AC-R26 isolates a leaf rename.
    writeFileSync(join(newSterling, 'enforcement-taint.json'), readFileSync(latchPath(p.dir)));
    writeFileSync(join(newSterling, 'config.json'), readFileSync(configJsonPath(p.dir)));
    writeFileSync(join(newSterling, 'enforcement-baseline.json'), 'attacker-manifest-never-verified, not even valid JSON');
    return p;
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R32');

  const { dir, cleanup } = build();
  const staging = join(dir, 'staging');
  const newSterling = join(staging, 'sterling-new');
  try {
    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        renameSync(join(dir, '.sterling'), join(staging, 'sterling-verified'));
        renameSync(newSterling, join(dir, '.sterling'));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R3): substituting the manifest DIRECTORY after the verdict launders the surface for call N+1 while the retained baseline descriptor still reads clean. reason: ${reasonOf(result)}`
    );
    // THE DURABLE EFFECT, checked in BOTH trees (same discipline as AC-R49):
    // the genuinely-verified latch, now detached, survives — and a latch-
    // shaped file still sits at the live path too, whichever object the
    // module's own resolution touches.
    assert.equal(existsSync(join(staging, 'sterling-verified', 'enforcement-taint.json')), true, 'the genuinely-verified latch, now detached inside the renamed-aside .sterling, survives');
    assert.equal(existsSync(latchPath(dir)), true, 'a latch-shaped file survives at the LIVE path too');
    assert.match(reasonOf(result), /\.sterling|baseline/i, `the refusal NAMES the substituted manifest directory — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to the DIRECTORY being substituted, not to a content disagreement (the retained descriptor still reads the GOOD manifest) — reason: ${reasonOf(result)}`);
    assert.match(readFileSync(baselinePath(dir), 'utf8'), /attacker-manifest-never-verified/, 'sanity: the substitution actually landed on the LIVE path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R33 CONTROL — A PROJECT WITH NO `.claude` AT ALL RECONCILES NORMALLY.
// PLACED FIRST as AC-R34's control, and it must pass for the OPPOSITE reason.
//
// Without it, AC-R34's refusal has two possible causes: "the expected-absence
// retention fired" and "this module simply cannot reconcile a project that has
// no `.claude` directory". A green AC-R34 would then carry no evidence at all.
// This arm proves the absent-root fixture is otherwise clearable.
//
// EXPECTED: GREEN TODAY (no new seam, no new guard — it exercises the existing
// enumeration over a surface that happens to be one file).
//
// SABOTAGE: make an absent (B) root a refusal in its own right — this control
// flips to cleared:false, and AC-R34 immediately stops proving anything, which
// is the signal to re-examine that pin rather than trust its green.
// ===========================================================================
test('AC-R33 CONTROL: a project with NO `.claude` directory reconciles normally against a baseline attesting the remaining (B) surface', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    plantLatch(dir);
    writeBaseline(dir, [baselineEntryFor(dir, CONFIG_REL)]); // the whole (B) surface, exactly

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(result.cleared, true, `CONTROL: an absent (B) root is not itself a refusal — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: the latch is genuinely removed, so AC-R34\'s refusal can only be the appearance of `.claude`');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R34 — THE ABSENT-ROOT VARIANT, WHICH 0ac7be95 R3 CALLS WORSE BECAUSE IT
// NEEDS NO RENAME: "when `.claude` did not exist at verification, NO directory
// evidence is recorded at all, so CREATING `.claude/settings.json` after the
// verdict is invisible to all three binding properties."
//
// THE FIX R3 NAMES: retain EXPECTED ABSENCE and require `lstat` to still return
// ENOENT at confirmation.
//
// WHY NOTHING ELSE CAN SEE IT: there is no retained descriptor for `.claude`
// (it never existed), so (a), (b) and (c) have nothing to check; the baseline is
// untouched, so (d) is blind; and there is no directory EDGE to rebind either —
// which is exactly why an absence must be retained as evidence in its own
// right. An implementation that rebinds only PRESENT edges passes AC-R30..R32
// and still fails here.
//
// DISCLOSED LIMIT: if a future implementation re-lists the repo ROOT's
// membership, that could also catch this. The reason assertion is what keeps
// the pin attributable to the retained absence — it must name `.claude`.
//
// INJECTED AT SEAM 4b FOR THE SAME REASON AS AC-R30: expected-absence is part
// of the root/edge evidence, which runs at BOTH the first and the last position
// inside `confirmBoundEvidence`. Injecting between them means only the
// LAST-position re-confirmation of the retained ENOENT can refuse.
//
// EXPECTED FAILURE SHAPE: the seams exist now. RED with `cleared:true` means
// expected-absence is either not retained at all, or is only re-confirmed at
// the first position — both are the R3 defect, and the reason wording tells
// them apart from a `hookCalls` failure, which would mean the seam regressed.
//
// SABOTAGE (after the fix, one line): stop recording expected-absence for a
// missing (B) root (record only present roots) — cleared:true, and a whole
// enforcement directory can be installed inside the reconciliation window.
// ===========================================================================
test('AC-R34: `.claude` CREATED after the final verdict, in a project where it was absent at verification, must not clear — expected ABSENCE is evidence and must be re-checked', { skip: BEHAVIOURAL_SKIP }, async () => {
  const build = () => {
    const p = makeGitProject();
    rmSync(join(p.dir, '.claude'), { recursive: true, force: true });
    plantLatch(p.dir);
    writeBaseline(p.dir, [baselineEntryFor(p.dir, CONFIG_REL)]); // identical to AC-R33's proven-clearing fixture
    const staging = makeStaging(p.dir);
    const newClaude = join(staging, 'claude-new');
    mkdirSync(join(newClaude, 'agents'), { recursive: true });
    writeFileSync(join(newClaude, 'agents', 'coder.md'), '# TAMPERED — installed inside the reconciliation window\n');
    writeFileSync(join(newClaude, 'settings.local.json'), JSON.stringify({ hooks: 'disabled' }) + '\n');
    return p;
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST. AC-R33 is the plain absent-root
  // control; this one additionally carries the staged `staging/claude-new`
  // tree, so it is THIS fixture that must be shown clearable.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R34');

  const { dir, cleanup } = build();
  const newClaude = join(dir, 'staging', 'claude-new');
  try {
    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        renameSync(newClaude, join(dir, '.claude'));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R3, the absent-root variant): an enforcement surface that did not exist at verification and exists now was never verified. AC-R33 proves this fixture otherwise clears, so the refusal can only be the appearance of \`.claude\`. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a (B) root appearing after the verdict');
    assert.match(
      reasonOf(result),
      /\.claude/,
      `the refusal NAMES the path whose retained ABSENCE was violated — reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.expectedAbsence, `the verdict is attributed to something APPEARING that was recorded absent — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(join(dir, '.claude', 'agents', 'coder.md')), true, 'sanity: the tamper actually landed on disk');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R35 CONTROL — `_testForcePlatform` IS AN OVERRIDE, NOT A KILL SWITCH.
// PLACED FIRST, and it is AC-R36's control: it must pass for the OPPOSITE
// reason.
//
// AC-R36 asserts that a refusal happens under a forced win32 platform. THAT
// VERDICT HAS MORE THAN ONE POSSIBLE CAUSE, and they are indistinguishable from
// a red/green result alone:
//   (i)  the win32 arm refuses — the ruling, and the thing being pinned;
//   (ii) supplying `_testForcePlatform` AT ALL denies (the cheapest possible
//       way to make AC-R36 green while pinning nothing whatsoever).
// This arm supplies the SAME seam with a NON-win32 value against AC-R1's
// proven-clearing fixture and requires the call to CLEAR, which excludes (ii)
// and makes a green AC-R36 carry its evidence.
//
// THE SEAM IS AN OR, NOT AN ASSIGNMENT — `REAL_WIN32 || FORCED_WIN32_DEPTH > 0`
// — so forcing a non-win32 value can only ever be a NO-OP and can never turn a
// real Windows host into a posix one. That is the safe direction: the seam
// cannot be used to DEGRADE the platform arm, only to reach it. This control
// consequently skips on a real win32 host (BEHAVIOURAL_SKIP), where the honest
// arm is AC-R36's natural one.
//
// EXPECTED: GREEN TODAY on a posix host — the seam exists and this is AC-R1's
// fixture. If it goes RED with `cleared:false`, the finding is THE SEAM, and
// AC-R36 must be treated as proving nothing until that is resolved.
//
// SABOTAGE: make the module refuse whenever `_testForcePlatform` is present at
// all — this control flips to cleared:false while AC-R36 stays green, and the
// pair stops agreeing. That divergence is the whole point of running them
// together.
// ===========================================================================
test('AC-R35 CONTROL: forcing a NON-win32 platform is a no-op and AC-R1\'s fixture still CLEARS — the seam is an override, not an unconditional deny', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, _testForcePlatform: 'linux' });

    assert.equal(
      result.cleared,
      true,
      `CONTROL: forcing a NON-win32 platform must change nothing — this is AC-R1's fixture and it must still clear. A refusal here means the seam itself denies, and AC-R36 would then prove nothing at all. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: the latch is genuinely removed, so AC-R36\'s refusal is attributable to the PLATFORM VALUE and to nothing else');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R36 — R4: WINDOWS REFUSES RATHER THAN DEGRADES, AND LEAVES THE LATCH
// PRESENT. THIS RULING SHIPPED COMPLETELY UNPINNED, WHICH IS THE R5 PATHOLOGY
// THIS WHOLE PASS EXISTS TO END.
//
// 0ac7be95 R4: the win32 arm has no parent binding and would fall back to a
// path-addressed re-read, which retains the original TOCTOU and permits path
// substitution between checks. Against the standing Windows/Linux parity
// requirement — most Sterling users are Windows users — a silently weaker
// Windows guarantee is not acceptable. THE SAFE WINDOWS BEHAVIOUR IS TO REFUSE
// RECONCILIATION AND LEAVE THE LATCH PRESENT.
//
// BOTH HALVES ARE PINNED AND THE SECOND IS THE ONE THAT MATTERS: refusing is
// only half the ruling; the LATCH MUST STILL BE THERE. A "refusal" that removes
// the latch anyway, or that reports `cleared:false` after unlinking, would
// satisfy a naive pin while re-opening the entire enforcement surface. The
// third assertion adds the attribution: the refusal must name the PLATFORM, not
// borrow a verification family — the fixture is byte-identical to AC-R1's,
// which clears, so a baseline- or latch-family reason would mean the platform arm
// never fired and something else refused by accident.
//
// NOT DIRECTLY OBSERVABLE, DISCLOSED RATHER THAN IMPLIED: a test cannot see
// WHICH primitive re-read the latch, so it cannot pin "does not degrade" as
// such. What it can see is that the win32 arm never reaches a clear, which is
// what R4 actually rules.
//
// THIS TEST DELIBERATELY DOES NOT CARRY `BEHAVIOURAL_SKIP`: on a genuine
// Windows host it is the ONE pin that must run, and there it runs its NATURAL
// arm — NO SEAM AT ALL. A pin for "what Windows does" that only ever exercises
// a simulation on the one platform where the real thing is available would be
// pinning the simulation.
//
// EXPECTED FAILURE SHAPE: RED with `cleared:true` if the win32 arm is absent —
// the fixture is AC-R1's, so the posix logic clears it. RED with a
// non-platform reason if the arm exists but is not attributable. If it goes red
// while AC-R35 is ALSO red, treat the SEAM as suspect first (see AC-R35).
//
// SABOTAGE (one line): delete the `isWin32()` refusal arm — `result.cleared`
// flips true and the latch vanishes. The article records that all 17
// platform-arm sites route through that ONE accessor, so this is genuinely one
// edit and there is no second layer to hide behind.
// SECOND SABOTAGE: keep the refusal but unlink the latch before returning —
// `cleared:false` still holds and ONLY the `existsSync` assertion fires, which
// is the half a naive pin would have missed entirely.
// ===========================================================================
test('AC-R36: on win32 reconciliation REFUSES and LEAVES THE LATCH PRESENT — it never degrades to a path-addressed re-read', { skip: GIT_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture: everything else is perfect

    // On a real win32 host the NATURAL arm is exercised — no seam, nothing to
    // disbelieve. Elsewhere the seam forces the arm into reach.
    const result = ON_WIN32
      ? await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR })
      : await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, _testForcePlatform: 'win32' });

    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R4): win32 has no parent binding, so it must REFUSE rather than degrade to a path-addressed re-read. A clear here is a silently weaker guarantee on the platform most Sterling users run. reason: ${reasonOf(result)}`
    );
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      'THE HALF THAT MATTERS: refusing is not enough — the latch must be LEFT PRESENT, so the enforcement surface stays closed until reconciliation can be done safely'
    );
    assert.match(
      reasonOf(result),
      REASON.platformRefusal,
      `the refusal is attributed to the PLATFORM, not to a verification guard (the fixture is byte-identical to AC-R1's, which clears) — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op verdict would misreport the platform refusal as nothing-to-do');
    assert.doesNotMatch(reasonOf(result), REASON.baseline, 'the baseline is exact here; a baseline-family reason would mean the platform arm never fired');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R37 — R6: THE PRE-UNLINK BOUND CONFIRMATION MUST BE SYNCHRONOUS.
//
// 0ac7be95 R6, accepted-but-conditional: not awaiting `confirmBoundEvidence` is
// SOUND for the callback actually supplied — it is synchronous and throws
// synchronously, so an `await` would only add a microtask turn into the very
// window the design is trying to keep empty. IT BECOMES UNSAFE THE MOMENT
// ANYONE MAKES THAT CALLBACK ASYNCHRONOUS, because its promise would be ignored
// and THE UNLINK WOULD PROCEED REGARDLESS — every binding property silently
// stops gating the removal while the suite stays green. R6's own words: "Guard
// that with a comment and an assertion, not with a convention."
//
// TWO INDEPENDENT ARMS, because neither subsumes the other:
//   1. the callback is not an `async function` (the obvious refactor);
//   2. invoking it does not return a THENABLE (the subtle one — a sync wrapper
//      that returns `somethingAsync()` has constructor.name 'Function' and
//      would pass arm 1 while being just as unsafe).
// Arm 2 tolerates a SYNCHRONOUS THROW as proof of synchrony, since an async
// function cannot throw synchronously.
//
// CONTROL ARMS FIRST: the detectors are proven to detect. A green run means
// nothing if `looksAsyncFunction` cannot see an async function, and that
// vacuity is invisible from the outcome alone.
//
// DISCLOSED: arm 2 calls the confirmation a second time. It is a read-only
// re-confirmation on an untampered fixture, so it must neither throw nor
// mutate; if a future implementation makes it non-idempotent, arm 2 needs
// rethinking and arm 1 continues to carry the pin.
//
// WHAT THIS PIN CANNOT REACH, DISCLOSED RATHER THAN IMPLIED. The module carries
// its own runtime guard for R6 — a thenable returned by the confirmation
// REFUSES — and THAT GUARD IS UNREACHABLE THROUGH THE PUBLIC EXPORT: the only
// call site constructs the callback itself as a hardcoded synchronous arrow,
// and no seam lets a test substitute a different one. `_testHookBeforeConfirm`
// HANDS the callback out; it does not take one in. So the branch cannot be
// driven and is deliberately NOT pinned — pretending otherwise would be a test
// that asserts a code path it never executes. What IS reachable, and what this
// test pins, is the STATIC PROPERTY the guard exists to protect: the callback
// actually handed to the seam is neither an AsyncFunction nor a thenable-
// returning wrapper. If a future change gives the removal step a caller-
// supplied confirmation, the refusal branch becomes reachable and deserves its
// own pin at that moment.
//
// EXPECTED FAILURE SHAPE: the seam exists now, so `calls` should be 1. RED on
// arm 1 or arm 2 means the callback became asynchronous — the R6 hazard,
// realised.
//
// SABOTAGE (one line): change the confirmation to `async function
// confirmBoundEvidence(...)` — arm 1 fires. SECOND SABOTAGE: keep it sync but
// return a promise from inside it — arm 2 fires.
// ===========================================================================
test('AC-R37: the pre-unlink bound confirmation is SYNCHRONOUS — an async callback would have its promise ignored and the unlink would proceed regardless', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ---- CONTROL ARMS, PLACED FIRST: the detectors actually detect.
  assert.equal(looksAsyncFunction(async () => {}), true, 'CONTROL: the async-function detector must see an async arrow');
  assert.equal(looksAsyncFunction(async function named() {}), true, 'CONTROL: the async-function detector must see an async function declaration');
  assert.equal(looksAsyncFunction(() => {}), false, 'CONTROL: the detector must NOT flag an ordinary function, or the pin below is unfalsifiable');
  assert.equal(isThenable(Promise.resolve()), true, 'CONTROL: the thenable detector must see a promise');
  assert.equal(isThenable(undefined), false, 'CONTROL: the thenable detector must not flag undefined');

  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // untouched fixture: the confirmation must succeed

    let calls = 0;
    let confirmFn = null;
    let armOneFailure = null;
    let armTwoFailure = null;

    await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookBeforeConfirm: (fn) => {
        calls += 1;
        confirmFn = fn;

        if (looksAsyncFunction(fn)) {
          armOneFailure = `the confirmation is an AsyncFunction (${fn.name || 'anonymous'})`;
        }

        // ARM 2 — invoke it and inspect the RETURN. A synchronous throw is
        // itself proof of synchrony (an async function returns a rejected
        // promise instead of throwing), so it is not a failure here.
        let ret;
        let threwSync = false;
        try {
          ret = fn();
        } catch {
          threwSync = true;
        }
        if (!threwSync && isThenable(ret)) {
          armTwoFailure = 'the confirmation returned a thenable — its result would be ignored and the unlink would proceed regardless';
        }
      },
    });

    assert.equal(calls, 1, 'SEAM 4 CONTRACT: the seam must fire exactly once and hand over the confirmation callback — see AC-R25');
    assert.equal(typeof confirmFn, 'function', 'SEAM 4 CONTRACT: the seam receives the exact callback that runs as the pre-unlink bound confirmation');
    assert.equal(
      armOneFailure,
      null,
      `THE RULING (0ac7be95 R6): the pre-unlink confirmation must be SYNCHRONOUS. It is deliberately NOT awaited — an await would schedule a microtask into the window between the last check and the unlink — so an async callback's promise is dropped on the floor and the unlink proceeds no matter what the confirmation found. ${armOneFailure ?? ''}`
    );
    assert.equal(
      armTwoFailure,
      null,
      `THE SUBTLE HALF: a synchronous wrapper that RETURNS a promise passes the constructor-name check and is exactly as unsafe. ${armTwoFailure ?? ''}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R38 — THE IDENTITY-ARM ORDERING. 0ac7be95 R5: swapping the two arms leaves
// the suite green "because no test supplies the distinguishing shape —
// `callerAgentId` PRESENT AND `callerRole !== 'conductor'`". This test supplies
// exactly that shape.
//
// WHY THE ORDER IS A REAL PROPERTY AND NOT A STYLE PREFERENCE: the article
// states it outright — "the agent-identity arm is checked FIRST so a spoof is
// attributed as a spoof rather than as an omission". Both orders REFUSE, so the
// `cleared` assertion can never distinguish them; the whole verdict rests on
// WHICH REASON comes back, which is why the two arms must have distinguishable
// wording (the reason-vocabulary contract) and why the control arms below are
// mandatory rather than decoration. An agent probing the gate and being told
// "you forgot to declare a role" learns to declare one; being told "an agent
// caller is not authorized" is the truthful, non-coaching answer, and the
// incident is attributed correctly in whatever log consumes it.
//
// AC-R10 and AC-R24 each exercise ONE arm in isolation and cannot see the order
// at all — that is precisely why the mutation pass found the ordering unpinned
// through a green suite.
//
// EXPECTED FAILURE SHAPE: RED if the arms are ordered role-first (the pin arm
// returns the missing-conductor-assertion wording), or if both arms share one
// undiscriminated wording (CONTROL 2 fires). Expected GREEN today if the
// agent-first order the article describes is really live — this test makes that
// order regression-visible, which it currently is not.
//
// SABOTAGE (one line): swap the two `if` arms in the identity gate so the
// `callerRole !== 'conductor'` check runs first — the pin arm's
// `doesNotMatch(missingConductorAssertion)` and `match(agentCaller)`
// assertions fire, while every other identity test in this file stays green.
// ===========================================================================
test('AC-R38: with BOTH an agent identity AND a non-conductor role, the AGENT arm is what answers — a spoof is attributed as a spoof, not as an omission', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ---- CONTROL 1, PLACED FIRST: the AGENT arm is reachable and has its own
  // wording. (Same shape as AC-R10; repeated here deliberately, because this
  // test's verdict is a comparison BETWEEN the two arms' wordings and it must
  // carry its own evidence that each arm can be seen at all.)
  {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));
      const r = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, callerAgentId: 'agent-abc123' });
      assert.equal(r.cleared, false, `CONTROL 1: an agent identity refuses — reason: ${reasonOf(r)}`);
      assert.match(reasonOf(r), REASON.agentCaller, `CONTROL 1: the AGENT arm has wording that names the agent caller — without it the two arms are indistinguishable and this whole test is vacuous. reason: ${reasonOf(r)}`);
    } finally {
      cleanup();
    }
  }

  // ---- CONTROL 2: the OMISSION arm is reachable and its wording is DISTINCT
  // from the agent arm's. This is the arm that catches a "fix" that widens one
  // family until it swallows the other — which would make the pin below green
  // under either ordering.
  {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));
      const r = await reconcileEnforcementTaint({ cwd: dir });
      assert.equal(r.cleared, false, `CONTROL 2: an omitted conductor assertion refuses — reason: ${reasonOf(r)}`);
      assert.match(reasonOf(r), REASON.missingConductorAssertion, `CONTROL 2: the OMISSION arm names the omission — reason: ${reasonOf(r)}`);
      assert.doesNotMatch(
        reasonOf(r),
        REASON.agentCaller,
        `CONTROL 2: the two arms must be TELLABLE APART. If the omission arm also reads as an agent-caller refusal, the ordering pin below cannot discriminate and is hollow by construction. reason: ${reasonOf(r)}`
      );
    } finally {
      cleanup();
    }
  }

  // ---- THE PIN: the distinguishing shape. BOTH gates would refuse; only the
  // ORDER decides which one answers.
  for (const shape of [
    { callerRole: 'agent', callerAgentId: 'agent-abc123' },
    { callerRole: 'subagent', callerAgentId: 'agent-abc123' },
    { callerAgentId: 'agent-abc123' }, // role omitted entirely — still an agent first
  ]) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));

      const r = await reconcileEnforcementTaint({ cwd: dir, ...shape });
      assert.equal(r.cleared, false, `both arms refuse; ${JSON.stringify(shape)} must never clear — reason: ${reasonOf(r)}`);
      assert.equal(existsSync(latchPath(dir)), true, `the latch survives ${JSON.stringify(shape)}`);
      assert.match(
        reasonOf(r),
        REASON.agentCaller,
        `THE RULING: the AGENT-IDENTITY arm is checked FIRST, so a caller carrying an agent identity is attributed as a SPOOF, not as a missing declaration. shape=${JSON.stringify(shape)} reason: ${reasonOf(r)}`
      );
      assert.doesNotMatch(
        reasonOf(r),
        REASON.missingConductorAssertion,
        `THE DISCRIMINATOR: an omission wording here means the role arm ran first — the ordering is inverted, and an agent probing the gate is told how to get further rather than that it is not authorized. shape=${JSON.stringify(shape)} reason: ${reasonOf(r)}`
      );
    } finally {
      cleanup();
    }
  }
});

// ###########################################################################
// AC-R39 .. AC-R45 — THE ENUMERATION AND SIZE BOUNDS (0ac7be95 R7).
//
// R5, verbatim: "ALL SIX DoS bounds, for which the test file contains NO
// ASSERTION WHATSOEVER." The article documents SEVEN — depth 16, directories
// 32, files 256, dirents 4096, 8 MiB per file, 64 MiB total, baseline 8 MiB — and
// all seven are pinned below rather than guessing which one the count omitted.
//
// THE HOLLOWNESS TRAP THESE PINS ARE BUILT TO AVOID, and the reason a bound
// test is harder to write than it looks: AN OVERSIZED FIXTURE ALSO BREAKS THE
// EXACT-MANIFEST MATCH. A bound test that asserts only `cleared:false` is
// therefore satisfied with EVERY BOUND DELETED — the manifest guard refuses the
// unattested extra files and the pin never notices. Two devices close it:
//   1. WHEREVER POSSIBLE THE OVERSIZED FIXTURE IS EXACTLY ATTESTED (or adds no
//      (B) files at all), so with the bound deleted the call CLEARS and the pin
//      goes red on the DURABLE EFFECT, not on wording. AC-R39, AC-R40, AC-R41,
//      AC-R43, AC-R44 and AC-R45 are all built this way.
//   2. The reason must be attributed to a BOUND (LIMIT) and to WHICH BOUND
//      (DIMENSION.*), and, where the sibling is reachable, must NOT read as a
//      manifest refusal nor as the confusable neighbouring bound. `REASON.bounds`
//      alone says only "some limit fired"; with seven limits in play that leaves
//      six of them satisfiable by the seventh, which is a hollow set of pins
//      wearing seven ids. `doesNotMatch(REASON.ordinaryMismatch)` is separately
//      required on each: A BOUND IS A REFUSAL, NOT A TRUNCATION — a walk that
//      silently stops at the limit and lets the missing paths surface later as a
//      baseline disagreement reports the wrong cause, and against a baseline built the
//      same truncated way it would not refuse at all.
//
// NOT REACHABLE BY TEST, DISCLOSED RATHER THAN IMPLIED: R7's actual defect is
// that two bounds are ALLOCATED BEFORE THEY ARE CHECKED (`readdirSync`
// materializes the whole directory before the 4096 count is enforced; the
// win32 hashing path `readFileSync`s before enforcing 8 MiB; the baseline read
// allocates after an `fstat` that concurrent growth can outrun). Demonstrating
// exhaustion requires a fixture whose whole point is to consume the host's
// memory, which is not a test anyone should run in CI. These pins therefore
// hold the REFUSAL SEMANTICS — the bound is enforced and says so — and leave
// the allocation ORDER to review. Nothing here would go red if a future edit
// moved a check back after its allocation.
//
// COST: these fixtures create ~4,500 small files and ~77 MiB of data in the
// system temp directory across the block. That is the price of pinning bounds
// at all; each fixture is torn down in its own `finally`.
// ###########################################################################

// ===========================================================================
// AC-R39 — DEPTH (16). A 20-deep chain of EMPTY directories under
// `.claude/agents`: it adds no (B) file, so the manifest still matches exactly
// and — with the depth bound deleted — the call CLEARS. Total directory count
// stays at ~24, comfortably under the 32 bound, so the refusal cannot be the
// directory bound wearing depth's clothes.
//
// SABOTAGE (one line): delete the depth check from the walk — `result.cleared`
// flips true and an arbitrarily deep tree is walked without limit.
// ===========================================================================
test('AC-R39: a (B) subtree deeper than the depth bound REFUSES, and says it was a bound', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    let deep = join(dir, '.claude', 'agents');
    for (let i = 1; i <= 20; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true }); // 20 levels, all EMPTY: no new (B) file
    writeBaseline(dir, exactBaselineFor(dir)); // still EXACT — with the bound gone this fixture clears

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(result.cleared, true, `a subtree deeper than the bound must refuse, not be silently truncated — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal (fail-STOP, not fail-open)');
    assert.match(
      reasonOf(result),
      LIMIT,
      `the verdict must be attributed to a BOUND. The baseline is EXACT here, so any other family would mean the depth limit never fired — reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), DIMENSION.depth, `and must name WHICH bound: DEPTH. Without this, six other limits satisfy this pin — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'a bound is a REFUSAL, not a truncation that surfaces later as a manifest disagreement');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R40 — DIRECTORY COUNT (32). 40 EMPTY sibling directories: again no new (B)
// file, so with the bound deleted the exact manifest still matches and the call
// CLEARS. Depth stays at 3, so this cannot be the depth bound.
//
// SABOTAGE (one line): delete the directory-count check — cleared:true.
// ===========================================================================
test('AC-R40: more walked (B) directories than the directory bound REFUSES, and says it was a bound', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    for (let i = 0; i < 40; i++) mkdirSync(join(dir, '.claude', 'agents', `sub${i}`), { recursive: true });
    writeBaseline(dir, exactBaselineFor(dir)); // EXACT — empty directories contribute no (B) file

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(result.cleared, true, `more directories than the bound must refuse — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `the verdict must be attributed to a BOUND — the baseline is EXACT, so nothing else can explain a refusal — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), DIMENSION.dirCount, `and must name WHICH bound: the DIRECTORY count — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), DIMENSION.depth, `THE DISCRIMINATOR vs AC-R39: depth stays at 3 here, so a depth reason would mean this fixture is measuring AC-R39's guard — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'a bound is a refusal, not a truncation surfacing later as a manifest disagreement');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R41 — FILE COUNT (256), documented as an FD BUDGET rather than a size
// preference: the evidence binding holds ONE OPEN DESCRIPTOR PER HASHED LEAF,
// so exceeding it is not a policy question but a descriptor-exhaustion one, and
// raising it requires an RLIMIT_NOFILE check. 303 (B) files, EVERY ONE EXACTLY
// ATTESTED — so with the bound deleted this fixture CLEARS (and, on the way,
// opens 303 descriptors, which is the thing the bound exists to prevent).
//
// SABOTAGE (one line): delete the file-count check — cleared:true.
// ===========================================================================
test('AC-R41: more (B) files than the file/FD bound REFUSES even when every one of them is exactly attested', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const extras = [];
    for (let i = 0; i < 300; i++) {
      const rel = `.claude/agents/extra-${String(i).padStart(4, '0')}.md`;
      writeFileSync(absOf(dir, rel), `# attested extra agent ${i}\n`);
      extras.push(rel);
    }
    writeBaseline(dir, exactBaselineForWith(dir, extras)); // EXACT over all 303 files

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: the file budget is an FD budget, so it refuses rather than proceeding — and it refuses even on a PERFECT manifest, which is what makes this a bound pin and not a manifest pin. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `the verdict must be attributed to a BOUND — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), DIMENSION.fileCount, `and must name WHICH bound: the FILE count (the fd budget) — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(
      reasonOf(result),
      DIMENSION.size,
      `THE DISCRIMINATOR vs AC-R43/AC-R44: this is a COUNT bound and every file here is tiny. Size wording would mean a byte budget fired instead — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(
      reasonOf(result),
      REASON.incomplete,
      'every file here IS attested; an incomplete-baseline reason would mean the bound never fired and the manifest guard is carrying the verdict'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R42 — THE DIRENT BOUND (4096). 4,200 junk entries placed DIRECTLY IN
// `.claude/`, not in `.claude/agents/`.
//
// THE BOUND IS CUMULATIVE PER CALL, NOT PER DIRECTORY. This wording matters and
// is corrected here deliberately: the counter is incremented for EVERY dirent
// the walk sees, across every directory it opens, BEFORE any relevance filter
// is applied — which is exactly why junk entries that match no (B) glob still
// cross it, and why "a single directory listing larger than the bound" (the
// earlier phrasing, and the module's own refusal message) describes only the
// easiest way to reach a limit that is actually a per-call total. Do not
// "correct" the fixture to put all 4,200 entries under one (B)-relevant path;
// the semantics are the cumulative ones and this fixture is valid against them.
//
// WHY THE ENTRIES GO IN `.claude/` AND NOT `.claude/agents/`: 4,200 files under
// `.claude/agents/` would cross the FILE bound (256) first, and 4,200
// SUBdirectories would cross the DIRECTORY bound (32) first, so inside the
// (B)-relevant set the dirent bound is unreachable in isolation. `.claude/` is
// walked (it must be, to reach `agents/` and `settings.local.json`) but its
// other entries match no (B) glob, so THE (B) SET STAYS AT EXACTLY THREE FILES
// and the baseline remains exact — which is what makes `cleared !== true`
// load-bearing here rather than incidental.
//
// IF THIS GOES RED WITH `cleared:true`, THE FINDING IS NOT "the fixture is
// wrong": it is that the counter runs AFTER a relevance filter rather than
// before it, making the constant unreachable without first crossing another
// bound. Report that as a dead constant; do not reshape the fixture until
// something refuses.
//
// SABOTAGE (one line): delete the cumulative dirent cap from the enumeration —
// the (B) set is unchanged and exactly attested, so `result.cleared` flips true.
// ===========================================================================
test('AC-R42: a walk whose cumulative dirent count exceeds the entry bound REFUSES with a bound-attributed reason, never as a manifest disagreement', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    for (let i = 0; i < 4200; i++) {
      writeFileSync(join(dir, '.claude', `junk-${String(i).padStart(5, '0')}.txt`), 'x');
    }
    writeBaseline(dir, exactBaselineFor(dir)); // the (B) set is still exactly the three attested paths

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: a walk that cannot fully account for the entries it saw is an UNKNOWN surface, and the (B) set here is EXACTLY attested — so with the bound deleted this fixture clears. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `THE PIN: the verdict must be attributed to a BOUND, not to the manifest — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), DIMENSION.dirents, `and must name WHICH bound: the ENTRY/dirent count — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(
      reasonOf(result),
      DIMENSION.fileCount,
      `THE DISCRIMINATOR vs AC-R41: the (B) FILE count here is three. A file-count reason would mean the junk entries were admitted as (B) files, and this fixture would be measuring AC-R41's guard — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(
      reasonOf(result),
      REASON.incomplete,
      'THE DISCRIMINATOR: an incomplete-baseline reason means the enumeration ran to completion and the manifest guard caught the fallout — i.e. no count bound fired at all, which is exactly the state R7 records'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R43 — PER-FILE SIZE (8 MiB). One 9 MiB (B) file, EXACTLY ATTESTED with its
// true hash — so with the bound deleted the manifest matches and the call
// CLEARS. Nothing else about the fixture is unusual: 4 files, 4 directories,
// depth 3, total well under 64 MiB.
//
// SABOTAGE (one line): delete the per-file size check — cleared:true, and the
// hasher will read whatever a planted file happens to be.
// ===========================================================================
test('AC-R43: a (B) file larger than the per-file size bound REFUSES even when its hash is exactly attested', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const rel = '.claude/agents/big.md';
    writeFileSync(absOf(dir, rel), Buffer.alloc(9 * 1024 * 1024, 0x61)); // 9 MiB > 8 MiB
    writeBaseline(dir, exactBaselineForWith(dir, [rel])); // EXACT — with the bound gone this clears

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(result.cleared, true, `an over-large (B) file must refuse — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `the verdict must be attributed to a BOUND — the hash is correct, so nothing else can explain a refusal — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), DIMENSION.size, `and must name WHICH bound: SIZE — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), /big\.md/, 'and must name the offending file — an unattributable size refusal cannot be acted on');
    assert.doesNotMatch(reasonOf(result), DIMENSION.total, `THE DISCRIMINATOR vs AC-R44: this is the PER-FILE bound, not the aggregate byte budget — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.hashMismatch, 'the attested hash is correct; a hash-mismatch reason would be a misattribution');
    assert.doesNotMatch(
      reasonOf(result),
      REASON.ordinaryMismatch,
      'THE TRUNCATION TRAP: a read that stops at the bound and hashes what it got produces a HASH MISMATCH against this fixture\'s whole-file baseline. That reports the wrong cause, and against a baseline built the same truncated way it would not refuse at all'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R44 — TOTAL SIZE (64 MiB). Nine 7.5 MiB files = 67.5 MiB, each one UNDER
// the 8 MiB per-file bound and all nine EXACTLY ATTESTED, so only the aggregate
// bound can refuse and — with it deleted — the call CLEARS. The per-file bound
// staying green here is what distinguishes this pin from AC-R43's.
//
// SABOTAGE (one line): delete the running-total check (keep the per-file one) —
// cleared:true, and AC-R43 stays green, which is the divergence that makes both
// tests necessary.
// ===========================================================================
test('AC-R44: a (B) surface whose TOTAL size exceeds the aggregate bound REFUSES even though every individual file is within the per-file bound', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    const chunk = Buffer.alloc(7864320, 0x62); // 7.5 MiB, under the 8 MiB per-file bound
    const extras = [];
    for (let i = 0; i < 9; i++) {
      const rel = `.claude/agents/bulk-${i}.md`;
      writeFileSync(absOf(dir, rel), chunk);
      extras.push(rel);
    }
    writeBaseline(dir, exactBaselineForWith(dir, extras)); // EXACT over ~67.5 MiB

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(result.cleared, true, `a (B) surface over the total-size bound must refuse — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `the verdict must be attributed to a BOUND — every file is individually legal and exactly attested — reason: ${reasonOf(result)}`);
    assert.match(
      reasonOf(result),
      DIMENSION.total,
      `and must name the TOTAL/aggregate bound SPECIFICALLY. THE DISCRIMINATOR vs AC-R43: every file here is under the per-file bound, so a bare "size" verdict cannot tell the two budgets apart and the aggregate one would stay unpinned — reason: ${reasonOf(result)}`
    );
    assert.doesNotMatch(reasonOf(result), REASON.incomplete, 'every file here IS attested; an incomplete-baseline reason would mean the bound never fired');
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'a bound is a refusal, not a truncation');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R45 — BASELINE SIZE (8 MiB). The padding is TRAILING WHITESPACE, so the baseline
// still parses to EXACTLY the valid manifest AC-R1 clears with: with the baseline
// size bound deleted the call CLEARS, and with it present the refusal cannot be
// explained by malformed JSON or by any manifest disagreement. That is the
// whole design of this fixture — a 9 MiB junk baseline would refuse as MALFORMED
// with the bound gone and pin nothing.
//
// SABOTAGE (one line): delete the baseline size check — cleared:true.
// ===========================================================================
test('AC-R45: a baseline file larger than the baseline size bound REFUSES, even though it parses to a perfectly valid exact manifest', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    // Valid JSON + 9 MiB of trailing whitespace: JSON.parse accepts it and
    // yields AC-R1's proven-clearing manifest, correctly shaped
    // {version, minted_at, entries}.
    writeRawBaseline(dir, JSON.stringify(wrapBaseline(exactBaselineFor(dir))) + ' '.repeat(9 * 1024 * 1024));

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(result.cleared, true, `an over-large baseline must refuse rather than be read — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a bound refusal');
    assert.match(reasonOf(result), LIMIT, `the verdict must be attributed to a BOUND — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), DIMENSION.size, `and must name the SIZE dimension — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), BINDING.baselineBinding, `and must name the BASELINE, not a (B) file — the (B) surface here is untouched and exactly three files — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(
      reasonOf(result),
      REASON.malformed,
      'THE DISCRIMINATOR: this baseline is VALID JSON and parses to the exact manifest. A malformed reason would mean the module read all 9 MiB and then tripped over something else — i.e. the bound never fired'
    );
  } finally {
    cleanup();
  }
});

// ###########################################################################
// THE TWO SURVIVING PINS FROM THE SECOND (NOW-MERGED) AUTHORING LANE — AC-R46
// and AC-R47. Everything else that lane wrote was a DUPLICATE of a pin above
// injected one window earlier (SEAM 2 rather than SEAM 4); since SEAM 2 is now
// confirmed to fire AFTER the second verification pass, the two windows are
// adjacent and those pins added no discriminating power under a second set of
// ids. They are DELETED rather than renumbered, and their stronger fixture
// constructions were folded into the pins above.
//
// THESE TWO SURVIVE BECAUSE NEITHER HAS A COUNTERPART ABOVE: a member
// DISAPPEARING (AC-R46 — AC-R27 pins only the APPEARANCE direction) and the
// baseline's IDENTITY arm (AC-R47 — AC-R28 pins only its CONTENT arm). Both are
// re-pointed at SEAM 4b, after the first-position root/edge check, so only the
// (a)-(d) content proofs can see their tamper.
// ###########################################################################

// ===========================================================================
// AC-R46 — BINDING PROPERTY (c): THE DISAPPEARANCE DIRECTION.
//
// DISCLOSED HONESTLY, BECAUSE THE MUTATION RULE DEMANDS IT: unlike AC-R27, THIS
// ARM IS NOT (c)-EXCLUSIVE — it is DEFENCE IN DEPTH, and the adjudication that
// merged the two lanes confirmed it as correct-as-written rather than hollow. A
// member that DISAPPEARS is visible to property (b) as well (its `lstat`
// through the retained parent returns ENOENT instead of the retained dev/ino),
// so deleting (c) alone may leave this test GREEN. That is a correct layered
// defence, not hollowness, and the distinction is exactly the one the
// mutation-verification rule says to RECORD rather than assume: AC-R27 is where
// property (c) is load-bearing ON ITS OWN; AC-R46 pins the PROPERTY (a vanished
// member is never silently accepted) across whichever layer carries it. Neither
// substitutes for the other, and striking this one would leave the
// disappearance direction unpinned entirely.
//
// THE SABOTAGE THAT MUST MAKE THIS RED IS THEREFORE A PAIR: delete the (c)
// name-set comparison AND make property (b) iterate the LIVE directory listing
// instead of the retained member set (so an absent member is simply skipped) —
// which is the single most natural way to write (b) wrongly. Under that pair
// the file vanishes with no verdict at all and the call clears.
// SINGLE-LINE VARIANT, if the implementation's (b) already skips ENOENT:
// deleting the (c) comparison alone flips this to cleared:true.
//
// EXPECTED FAILURE SHAPE: with neither layer present the call CLEARS and the
// `cleared`/`existsSync` assertions fire.
// ===========================================================================
test('AC-R46: BINDING (c) DISAPPEARANCE — a verified (B) member vanishing after the verdict must not clear', { skip: BEHAVIOURAL_SKIP }, async () => {
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    // A SECOND legitimate agent, present and attested at verification time.
    // This is why the fixture needs its own control: it is not AC-R25's.
    writeFileSync(join(p.dir, '.claude', 'agents', 'second.md'), '# a second legitimate agent, present and attested at verification time\n');
    writeBaseline(p.dir, [...exactBaselineFor(p.dir), ...baselineEntriesFor(p.dir, ['.claude/agents/second.md'])]);
    return p;
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R46');

  const { dir, cleanup } = build();
  const second = join(dir, '.claude', 'agents', 'second.md');
  try {
    let hookCalls = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        unlinkSync(second); // a verified member simply removed from the live set
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25');
    assert.equal(existsSync(second), false, 'sanity: the deletion actually landed on disk (a sabotage that fails to land looks exactly like a hollow test)');
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: the verdict accounted for a member that no longer exists. Clearing here discharges the incident against a surface that is no longer the one verified. reason: ${reasonOf(result)}`
    );
    assert.match(
      reasonOf(result),
      BINDING.broken,
      `the verdict must be attributed to the evidence changing since it was computed — membership OR identity, either LAYER is acceptable here and that is stated deliberately; SILENCE is not — reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), /second\.md|agents/, `the refusal NAMES the vanished member or its directory — an accidental catch-all cannot — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op reason would mean neither layer ran');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict member deletion');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R47 — BINDING PROPERTY (d): THE BASELINE'S IDENTITY ARM. The (b)-analogue for
// the baseline — a rename substitution with BYTE-IDENTICAL content, which the
// retained descriptor cannot see for the same structural reason AC-R26 names.
//
// ADJUDICATED GENUINELY LOAD-BEARING, AND THE ARGUMENT IS WORTH KEEPING
// BECAUSE THE OBVIOUS OBJECTION IS WRONG: "the per-EDGE retention (AC-R32)
// already covers the baseline's parent, so this is redundant." It is not.
// Per-edge retention covers DIRECTORY edges. A byte-identical baseline arriving
// by `rename` INSIDE `.sterling` moves NO directory edge — `.sterling` keeps
// its identity, its name set is unchanged (`enforcement-baseline.json`
// present before and after) — and it changes NO bytes behind the retained
// descriptor, so AC-R28's content re-read is blind too. ONLY an `lstat` of the
// baseline's own NAME through its pinned parent, compared against the retained
// dev/ino, can see it. Striking this pin would leave that arm unpinned
// entirely.
//
// WHY IT MATTERS: an attacker holding a write descriptor to the substituted
// inode rewrites the authorising document the moment the latch is gone, and
// that document is what call N+1 trusts.
//
// EXPECTED FAILURE SHAPE (RED): without the baseline-name re-lstat the call CLEARS
// — the retained descriptor still holds the verified bytes and nothing else
// looks.
//
// SABOTAGE (one line): re-read the retained baseline descriptor but never
// re-`lstat` the baseline's name through its pinned parent — AC-R28 stays GREEN
// (its bytes changed, this one's did not), AC-R32 stays GREEN (no directory
// moved), and ONLY this test flips to cleared:true.
// ===========================================================================
test('AC-R47: BINDING (d) IDENTITY — the baseline RENAME-SUBSTITUTED with byte-identical content after the verdict must not clear', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-success fixture

    const baselineBytes = readFileSync(baselinePath(dir));
    let hookCalls = 0;
    let idBefore = null;
    let idAfter = null;
    let bytesAfter = null;

    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        idBefore = identityOf(baselinePath(dir));
        // Staged in `src/` — OUTSIDE both the (B) surface and `.sterling` —
        // so no directory's name set is disturbed and AC-R32's edge check
        // cannot be the guard that carries this verdict.
        const staged = join(dir, 'src', 'staged-baseline.json');
        writeFileSync(staged, baselineBytes); // byte-identical
        renameSync(staged, baselinePath(dir)); // same name, NEW inode
        idAfter = identityOf(baselinePath(dir));
        bytesAfter = readFileSync(baselinePath(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25');
    // ---- FIXTURE CONTROLS: prove the construction that makes AC-R28's content
    // arm and AC-R32's edge check both blind.
    assert.notEqual(idAfter, idBefore, `FIXTURE CONTROL: the baseline's dev/ino must actually change, or this pins nothing about identity (before=${idBefore} after=${idAfter})`);
    assert.deepEqual(
      bytesAfter,
      baselineBytes,
      'FIXTURE CONTROL: the baseline bytes are IDENTICAL — that is what makes AC-R28\'s content re-read blind here, so a refusal is attributable to the identity arm alone'
    );
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING: the authorising document at the baseline path is no longer the inode the verdict read. An attacker holding a write descriptor to the substituted inode rewrites it the moment the latch is gone. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), BINDING.baselineBinding, `the verdict must NAME the baseline — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), BINDING.broken, `and must be attributed to its IDENTITY changing — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'the baseline content is byte-identical; a mismatch reason would mean the refusal came from somewhere other than the identity binding');
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present; a no-op reason would mean the binding never ran');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a post-verdict baseline substitution');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R48 — AN UNRECOGNISED `_test*` PROPERTY REFUSES BY NAME. THIS PIN GUARDS
// EVERY OTHER PIN IN THE FILE, AND IT EXISTS BECAUSE THE SILENT-DROP BEHAVIOUR
// IT FORBIDS ALREADY COST THIS SUITE SEVEN TESTS.
//
// THE MEASURED INCIDENT: an earlier draft of this block passed
// `_testHookBeforeConfirm` at a time when the module's destructuring accepted
// only three seams. An unknown property was SILENTLY DROPPED, so the hook never
// fired, seven tests injected NO TAMPER AT ALL, and each of them then asserted
// things about a call in which nothing had happened. That failure mode is
// invisible from the outside — it does not crash, it does not warn, and a pin
// that injects nothing can still look like a pin. It is the purest form of the
// hollow class this whole pass exists to end.
//
// SO THE FAIL-LOUD BEHAVIOUR IS ITSELF A GUARD AND MUST BE PINNED. With it, a
// TYPO in any seam name anywhere in this file surfaces as a loud refusal naming
// the property; without it, the typo produces a green test that measures
// nothing. The `hookCalls`/`calls` assertions on every seam pin are the second
// line of defence; this is the first.
//
// TOLERANT ON CALLING CONVENTION, STRICT ON EFFECT: "refuses loudly" is
// satisfied by EITHER a resolved `{cleared:false, reason}` naming the property
// OR a rejection whose message names it. The invariant is the DURABLE EFFECT
// (the latch survives) plus ATTRIBUTION (the offending name appears), not the
// shape of the return — the same treatment AC-R17 gives a failed removal.
//
// CONTROL ARM PLACED FIRST: the same fixture with ONLY recognised seams must
// CLEAR. Without it, "a call carrying an odd property refused" is equally
// explained by "this fixture refuses" — and this pin's whole subject is a
// module that must distinguish a recognised name from an unrecognised one.
//
// SABOTAGE (one line): restore the silent drop — destructure the known seams
// and ignore every other property — `cleared` flips true, the latch vanishes,
// and BOTH arms below fire. That single edit also re-opens the seven-hollow-pin
// failure, which nothing else in this file would catch.
// ===========================================================================
test('AC-R48: an unrecognised or misspelled `_test*` property REFUSES BY NAME — it is never silently dropped, because a dropped seam injects nothing and every pin using it goes hollow', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ---- CONTROL ARM, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON: the same
  // fixture with only RECOGNISED seams clears.
  {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));
      const r = await reconcileEnforcementTaint({
        cwd: dir,
        ...CONDUCTOR,
        _testHookBeforeConfirm: () => {},
      });
      assert.equal(r.cleared, true, `CONTROL: a RECOGNISED seam name must not refuse — otherwise the refusals below say nothing about recognition. reason: ${reasonOf(r)}`);
      assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: the latch is genuinely removed');
    } finally {
      cleanup();
    }
  }

  // ---- THE PIN: three misspellings, one per seam family, each against AC-R1's
  // proven-clearing fixture so a refusal is attributable to the NAME alone.
  for (const bad of ['_testHookBeforeConfrim', '_testForcePlatfrom', '_testHookInsideConfirmed']) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));

      let result;
      let threw = null;
      try {
        result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, [bad]: () => {} });
      } catch (e) {
        threw = e;
      }

      const text = threw ? oneLine(threw.message || String(threw)) : reasonOf(result);
      if (!threw) {
        assert.notEqual(result.cleared, true, `THE RULING: an unrecognised seam name must REFUSE, not be dropped. Dropping ${bad} means a typo anywhere in this file produces a test that injects nothing and passes. reason: ${text}`);
      }
      assert.equal(existsSync(latchPath(dir)), true, `THE DURABLE EFFECT: the latch survives an unrecognised-seam refusal (${bad})`);
      assert.match(
        text,
        new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `THE ATTRIBUTION: the refusal must NAME the offending property, or an operator cannot find the typo — and an unattributable {cleared:false} is exactly what a silent drop would look like from here. got: ${text}`
      );
    } finally {
      cleanup();
    }
  }
});

// ###########################################################################
// PRE-COMMIT REPAIR PASS — AC-R49 .. AC-R51. Authored against decisions
// 4b3183b8 (`ship-the-taint-clearer-alone-the-all-tool-gate-is-admission-
// control-not-quiescence`) and 0ac7be95 (`the-clearer-is-a-tripwire-not-a-
// boundary-...`) R1-R7, and against a MEASURED gap, not an alleged one.
//
// THE MEASUREMENT, stated first because it is what justifies AC-R49 existing:
// BOTH `confirmBoundRoots(roots);` call sites were replaced with comments, the
// sabotage was grep-proved present, and THE SUITE STAYED 48/48 GREEN. Every
// substitution fixture in this file moves `.claude`, `.claude/agents`,
// `.sterling`, a leaf, or the baseline — all of which are EDGES, caught
// by `confirmBoundEdges`. NOTHING renamed the PROJECT ROOT (`cwd`) itself,
// which is the only thing `confirmBoundRoots` uniquely proves. The corollary
// matters as much as the pin: the earlier four-red mutation (AC-R30/R31/R32/
// R34) is attributable to `confirmBoundEdges` ALONE, and AC-R30's comment
// claiming otherwise has been corrected above.
//
// AC-R50 closes the second half of the same class. AC-R25 pins the seam ORDER
// `['before','inside']`, but that ordering is STRUCTURALLY GUARANTEED by
// `beforeConfirm(...)` -> `beforeUnlink()` and therefore pins nothing about
// WHERE INSIDE `confirmBoundEvidence` the SEAM 4b call sits. Move that one call
// above the first-position `confirmBoundRoots`/`confirmBoundEdges` and
// AC-R26/R27/R28/R30/R31/R32/R34/R46/R47 ALL STAY GREEN while silently
// reverting to "some position of the check exists" — the exact hollowness they
// were written to escape.
// ###########################################################################

// Byte-for-byte recursive copy. Used ONLY by AC-R49, to build a replacement
// project root whose CONTENT is indistinguishable from the original and whose
// INODES are all different — the construction that makes every content proof
// structurally blind, exactly as AC-R26 does one level down at a leaf.
// Deliberately hand-rolled rather than `cpSync`: it refuses loudly on any entry
// type it cannot reproduce faithfully, so a fixture that silently failed to be
// byte-identical cannot masquerade as a pin.
function copyTreeSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyTreeSync(s, d);
    else if (entry.isFile()) writeFileSync(d, readFileSync(s));
    else throw new Error(`copyTreeSync: refusing to guess at a non-file, non-directory entry (${s}) — a fixture that is not byte-identical is not this pin`);
  }
}

// ===========================================================================
// AC-R49 — `confirmBoundRoots`: THE PROJECT ROOT (`cwd`) ITSELF SUBSTITUTED
// AFTER THE VERDICT. THE ONLY PIN IN THIS FILE THAT EXERCISES THAT GUARD.
//
// 0ac7be95 R3's last sentence, which every existing pin skipped: "If
// replacement of `cwd` itself is in scope, also retain the original root
// dev/ino and compare a fresh anchor against it." The module DOES retain the
// anchor's own dev/ino. Until this test, nothing checked that it ever LOOKS at
// it again — measured, 48/48 green with both call sites commented out.
//
// THE ATTACK: after the verdict, rename the project root aside and put a
// different directory at the same path. Every retained descriptor keeps
// resolving through the DETACHED tree; the operator's project — the thing the
// incident was raised about and the thing call N+1 will read — is now an object
// this module never verified, and the latch is discharged for it.
//
// WHY THIS IS ROOT-EXCLUSIVE AND NOT MERELY CORRELATED — the reasoning, stated
// so it can be checked rather than believed. Four content guards and the edge
// check are each blind BY CONSTRUCTION, not by luck:
//   * (a) re-hashing RETAINED DESCRIPTORS — the fds hold inodes in the detached
//     tree; their bytes never changed.
//   * (b) `lstat(retained-parent-fd, name)` — the retained parents ARE detached
//     directories, so every child name still resolves to the same inode.
//   * (c) re-listing RETAINED directory descriptors — same detached
//     directories, byte-identical name sets. NO NAME SET INSIDE THE PROJECT
//     CHANGES AT ALL: the swap happens at the project's PARENT (a tmpdir), and
//     both the aside name and the replacement are staged there BEFORE the call.
//   * (d) the baseline — reachable through its retained descriptor, unchanged; and
//     byte-identical at the live path too, so even a path-addressed re-read
//     agrees.
//   * `confirmBoundEdges` — EVERY retained edge's parent is a retained FD. The
//     topmost edge is (root-anchor-fd, `.claude`, dev/ino), and the root-anchor
//     fd is the OLD root inode, which still contains the original `.claude` at
//     the same dev/ino. An edge check cannot see a substitution ABOVE its own
//     topmost parent — that is definitionally what the anchor comparison is
//     for.
//   * THE REPLACEMENT IS A BYTE-IDENTICAL COPY (different inodes throughout),
//     which closes the last door: no content check of any kind, through a
//     retained fd OR by path, can produce this verdict. A tampered-content
//     replacement would have handed the refusal to a hash comparison and made
//     this pin correlated rather than exclusive.
// Therefore the ONLY observation that can refuse here is a fresh `lstat` of the
// `cwd` PATH compared against the retained anchor dev/ino — `confirmBoundRoots`.
//
// INJECTED AT SEAM 4b, so the FIRST-position `confirmBoundRoots` has already
// run and only the LAST-position one (the call adjacent to the unlink) can
// refuse. That makes this pin strictly stronger than its named sabotage
// requires, and it is the placement AC-R50 exists to keep honest.
//
// EXPECTED FAILURE SHAPE, ASSERTION BY ASSERTION:
//   * `hookCalls` !== 1        -> the SEAM regressed; a DIFFERENT finding, and
//                                 every seam pin in this file is uninterpretable
//                                 until it is fixed. Not this guard.
//   * fixture-control asserts  -> the swap did not actually happen on this host
//                                 (identical dev/ino) or the copy was not
//                                 byte-identical; the pin injected nothing.
//   * `result.cleared === true` -> THE GUARD IS GONE. This is the assertion that
//                                 fires under the named sabotage.
//   * either `existsSync`      -> the module unlinked a latch it was not
//                                 entitled to remove (whichever of the two trees
//                                 its unlink path resolves to).
//   * the reason asserts       -> the call refused, but NOT attributably to the
//                                 root anchor. That is a real finding about
//                                 attribution and must be reported, not softened
//                                 — but note it is the ONE class of failure here
//                                 that does not mean the guard is missing.
//
// NAMED SABOTAGE (the one this pin was written for): COMMENT OUT BOTH
// `confirmBoundRoots(roots);` CALL SITES, LEAVING `confirmBoundEdges(edges);`
// FULLY LIVE. This test MUST go RED on `result.cleared`; the other 48 MUST stay
// GREEN (they already do — measured).
// THE EXCLUSIVITY PAIR, WHICH MUST BE MEASURED AND NOT ASSUMED (the reasoning
// above is an argument, and an argument is not a measurement):
//   roots-only sabotage (both `confirmBoundRoots` calls out, edges live)
//       -> AC-R49 RED, everything else GREEN.
//   edges-only sabotage (both `confirmBoundEdges` calls out, roots live)
//       -> AC-R49 must stay GREEN, while AC-R30/R31/R32/R34 go RED.
// If AC-R49 goes red under the EDGES-only sabotage too, it is NOT
// root-exclusive and this comment is wrong — say so rather than keeping a claim
// of exclusivity nobody established.
// ===========================================================================
test('AC-R49: the PROJECT ROOT (`cwd`) itself renamed aside and replaced by a byte-identical tree after the final verdict must not clear — only the retained anchor dev/ino can see this', { skip: BEHAVIOURAL_SKIP }, async () => {
  // The fixture builder, used TWICE: once by the per-fixture control (no-op
  // seams, must CLEAR) and once by the pin. `staging/` is deliberately NOT used
  // here — the swap material lives OUTSIDE the project entirely, beside it in
  // the tmpdir, because anything staged INSIDE the tree would be part of the
  // tree being replaced.
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    writeBaseline(p.dir, exactBaselineFor(p.dir)); // AC-R1's proven-success fixture
    const aside = `${p.dir}.verified`;
    const replacement = `${p.dir}.replacement`;
    // Copied AFTER the latch and baseline exist, so the replacement is a complete,
    // byte-identical project — latch, baseline, (B) surface and all. A replacement
    // MISSING the latch or the baseline would let a "no latch present" or "no
    // baseline" refusal carry the verdict, and this pin would be measuring a
    // sibling guard.
    copyTreeSync(p.dir, replacement);
    return {
      dir: p.dir,
      aside,
      replacement,
      cleanup: () => {
        for (const t of [p.dir, aside, replacement]) rmSync(t, { recursive: true, force: true });
      },
    };
  };

  // ---- PER-FIXTURE CONTROL, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  // Without it, the refusal below has two possible causes — "the anchor guard
  // fired" and "a project with a byte-identical sibling copy beside it cannot
  // reconcile at all" — and a green would carry no evidence about THIS fixture.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R49');

  const { dir, aside, replacement, cleanup } = build();
  try {
    const originalCoderBytes = readFileSync(coderPath(dir));

    let hookCalls = 0;
    let rootIdBefore = null;
    let rootIdAfter = null;
    let coderIdBefore = null;
    let coderIdAfter = null;
    let coderBytesAfter = null;

    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      // SYNCHRONOUS AND RETURNING undefined ON PURPOSE — SEAM 4b is CALLED, NOT
      // AWAITED, and a thenable return REFUSES.
      _testHookInsideConfirm: () => {
        hookCalls += 1;
        rootIdBefore = identityOf(dir);
        coderIdBefore = identityOf(coderPath(dir));
        renameSync(dir, aside); // the verified tree, now detached from its name
        renameSync(replacement, dir); // a DIFFERENT object at the project's path
        rootIdAfter = identityOf(dir);
        coderIdAfter = identityOf(coderPath(dir));
        coderBytesAfter = readFileSync(coderPath(dir));
      },
    });

    assert.equal(hookCalls, 1, 'SEAM 4b CONTRACT: `_testHookInsideConfirm` must fire exactly once, INSIDE confirmBoundEvidence — after the FIRST-position confirmBoundRoots/confirmBoundEdges and BEFORE the (a)-(d) content proofs. See AC-R25 and AC-R50. A seam that never fires injects no tamper, and a pin that injects no tamper is not a pin');

    // ---- FIXTURE CONTROLS: prove ON THIS HOST that the construction the
    // exclusivity argument depends on actually held.
    assert.notEqual(rootIdAfter, rootIdBefore, `FIXTURE CONTROL: the project root's dev/ino must actually change, or this test pins nothing about the anchor (before=${rootIdBefore} after=${rootIdAfter})`);
    assert.notEqual(coderIdAfter, coderIdBefore, `FIXTURE CONTROL: the whole tree is a different set of objects — the live leaf must be a different inode too (before=${coderIdBefore} after=${coderIdAfter})`);
    assert.deepEqual(
      coderBytesAfter,
      originalCoderBytes,
      'FIXTURE CONTROL: the replacement tree is BYTE-IDENTICAL. That is what makes every content proof — (a) through a retained fd, or any re-hash by path — structurally blind, so the refusal cannot be attributed to a hash comparison'
    );

    // ---- THE PIN.
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (0ac7be95 R3, final sentence): the verdict authorised removal for a surface reached through ONE anchor, and the live project path now reaches a different directory object. Clearing here discharges the incident for a tree this module never read. reason: ${reasonOf(result)}`
    );
    // BOTH trees are checked deliberately. Under the sabotage the module unlinks
    // a latch, and WHICH ONE depends on whether its removal walk resolves
    // through the pinned parent (the detached tree) or by path (the live tree) —
    // an implementation detail this file must not depend on. Asserting both
    // makes the durable effect visible either way.
    assert.equal(existsSync(join(aside, '.sterling', 'enforcement-taint.json')), true, 'THE DURABLE EFFECT: the latch the module actually pinned — the one in the now-detached verified tree — survives');
    assert.equal(existsSync(latchPath(dir)), true, 'THE DURABLE EFFECT: the latch at the LIVE project path survives too, so no resolution path discharged the incident');

    assert.match(
      reasonOf(result),
      /\broot\b|\banchor\b|\bcwd\b|\bproject\b|\bworkspace\b|repositor|\btop[- ]level\b/i,
      `ATTRIBUTION: the refusal must name the ROOT/ANCHOR, not an edge or a leaf — that is what distinguishes "confirmBoundRoots fired" from "some sibling guard happened to refuse", and an unattributable {cleared:false} is what made AC-R15/AC-R16 hollow. IF THIS IS THE ONLY ASSERTION THAT FAILS, the finding is WORDING/attribution and NOT a missing guard — report it, do not soften it. reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to an IDENTITY substitution, not to a content disagreement — the bytes agree perfectly. reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.noLatch, 'the latch is present in both trees; a no-op verdict would mean the anchor comparison never ran');
    // NOTE ON WHAT IS DELIBERATELY *NOT* ASSERTED: REASON.ordinaryMismatch is
    // NOT excluded here. A deliberate anchor guard may legitimately say "dev/ino
    // mismatch" (AC-R30's measured run does), so excluding the word `mismatch`
    // would fail this pin for being correct.
    assert.match(readFileSync(coderPath(dir), 'utf8'), /coder \(legit\)/, 'sanity: the live path really does reach the replacement tree now');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R50 — SEAM 4b's PLACEMENT. THE PREMISE NINE OTHER PINS REST ON, AND UNTIL
// NOW NOTHING PINNED IT.
//
// WHAT IS ALREADY PINNED AND WHY IT IS NOT ENOUGH: AC-R25 asserts the seams fire
// in the order `['before','inside']`. That ordering is STRUCTURALLY GUARANTEED
// — `beforeConfirm(fn)` is called and then `beforeUnlink()` is invoked, so
// `inside` cannot precede `before` however `confirmBoundEvidence` is arranged
// internally. AC-R25 therefore says NOTHING about where inside
// `confirmBoundEvidence` the SEAM 4b call sits, which is the only thing that
// makes AC-R26/R27/R28/R30/R31/R32/R34/R46/R47/R49 mean what their comments
// claim. Move the one `_testHookInsideConfirm` call ABOVE the first-position
// `confirmBoundRoots(roots); confirmBoundEdges(edges);` and every one of those
// pins STAYS GREEN — their tampers are simply caught by the FIRST position
// instead of the last, so each silently degrades from "the LAST position
// exists" to "SOME position exists". That is precisely the hollow class this
// file's repair passes exist to end: green suite, live code, and A DIFFERENT
// GUARD than the one the test names is what satisfies it.
//
// THE OBSERVABLE THAT DISCRIMINATES, and why it needs no reason-wording at all:
// inject, at SEAM 4 (BEFORE `confirmBoundEvidence` is entered), a tamper the
// FIRST-POSITION check MUST catch — AC-R30's `.claude` rename-aside, which the
// file's own measured runs establish is caught by the first position. Then:
//   * SEAM 4b BELOW the first-position check (CORRECT): the check refuses
//     before the seam is ever reached -> `_testHookInsideConfirm` NEVER FIRES.
//   * SEAM 4b ABOVE the first-position check (SABOTAGED): the seam fires first
//     -> `insideFired === 1`.
// The verdict is a COUNT, not a message, so no wording change can move it and
// no catch-all can fake it.
//
// CONTROL ARM, PLACED FIRST AND MANDATORY: `insideFired === 0` has two possible
// causes — "the call refused upstream of the seam" (the pin) and "this seam is
// dead / this fixture never reaches confirmBoundEvidence" (which would make the
// pin vacuous, and is exactly the seven-hollow-tests incident AC-R48 records).
// `assertFixtureClearsWithNoopConfirm` runs THIS EXACT FIXTURE untampered and
// requires SEAM 4b to fire EXACTLY ONCE and the latch to be removed, so a green
// below carries its evidence.
//
// EXPECTED FAILURE SHAPE:
//   * `insideFired !== 0`   -> THE PIN. SEAM 4b is no longer downstream of the
//                              first-position root/edge check, and every pin
//                              listed above must be re-read as proving only
//                              "some position exists".
//   * `beforeFired !== 1`   -> SEAM 4 regressed; a different finding.
//   * `cleared === true`    -> the first-position check is gone entirely (a
//                              stronger failure than the one this pin targets).
//   * reason asserts        -> the call refused, but not attributably to the
//                              edge binding; report as attribution.
//
// NAMED SABOTAGE (one line): move the `_testHookInsideConfirm` invocation from
// BELOW the first-position `confirmBoundRoots(roots); confirmBoundEdges(edges);`
// to ABOVE it. THIS TEST GOES RED on `insideFired`; AC-R26/R27/R28/R30/R31/R32/
// R34/R46/R47/R49 ALL STAY GREEN, which is the entire reason it had to be
// written.
// ===========================================================================
test('AC-R50: SEAM 4b fires DOWNSTREAM of the first-position root/edge check — a tamper injected at SEAM 4 refuses before `_testHookInsideConfirm` is ever reached', { skip: BEHAVIOURAL_SKIP }, async () => {
  // The same fixture construction as AC-R30, for the same isolation reasons:
  // the replacement `.claude` is staged inside a pre-created `staging/` so the
  // repo root's name set is unchanged before, during and after the call.
  const build = () => {
    const p = makeGitProject();
    plantLatch(p.dir);
    writeBaseline(p.dir, exactBaselineFor(p.dir)); // AC-R1's proven-success fixture
    const staging = makeStaging(p.dir);
    const newClaude = join(staging, 'claude-new');
    mkdirSync(join(newClaude, 'agents'), { recursive: true });
    writeFileSync(join(newClaude, 'agents', 'coder.md'), '# TAMPERED — the live tree nobody verified\n');
    writeFileSync(join(newClaude, 'settings.local.json'), JSON.stringify({ hooks: 'disabled' }) + '\n');
    return p;
  };

  // ---- CONTROL ARM, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON: on this
  // exact fixture, untampered, SEAM 4b FIRES EXACTLY ONCE and the latch clears.
  // Without it, `insideFired === 0` below is equally explained by a dead seam.
  await assertFixtureClearsWithNoopConfirm(build, 'AC-R50');

  const { dir, cleanup } = build();
  const staging = join(dir, 'staging');
  const newClaude = join(staging, 'claude-new');
  try {
    let beforeFired = 0;
    let insideFired = 0;
    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      // SEAM 4: fires immediately BEFORE confirmBoundEvidence is entered, so
      // this tamper is in place when the FIRST-position check runs.
      _testHookBeforeConfirm: () => {
        beforeFired += 1;
        renameSync(join(dir, '.claude'), join(staging, 'claude-verified'));
        renameSync(newClaude, join(dir, '.claude'));
      },
      // SEAM 4b: pure WITNESS. It injects nothing; its call COUNT is the pin.
      _testHookInsideConfirm: () => {
        insideFired += 1;
      },
    });

    assert.equal(beforeFired, 1, 'SEAM 4 CONTRACT: `_testHookBeforeConfirm` must fire exactly once, so the tamper this pin depends on is actually in place. A failure here means SEAM 4 regressed and this verdict says nothing about SEAM 4b');
    assert.equal(
      insideFired,
      0,
      `THE PIN — SEAM 4b's PLACEMENT: a namespace substitution present BEFORE \`confirmBoundEvidence\` is entered must be refused by the FIRST-POSITION confirmBoundRoots/confirmBoundEdges, which sits ABOVE the SEAM 4b call. Reaching the seam (insideFired=${insideFired}) means the seam has moved above that check — and every pin that injects at SEAM 4b (AC-R26/R27/R28/R30/R31/R32/R34/R46/R47/R49) is then injecting into a window it does not describe, degrading from "the LAST-position re-check exists" to "SOME position exists" WITHOUT ANY OF THEM GOING RED. reason: ${reasonOf(result)}`
    );
    assert.notEqual(
      result.cleared,
      true,
      `the first-position check must REFUSE this substitution outright — if it clears, the root/edge check is absent altogether, which is a strictly worse finding than the placement this pin targets. reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), true, 'THE DURABLE EFFECT: the latch survives a namespace substitution injected before the bound confirmation');
    assert.match(reasonOf(result), /\.claude/, `ATTRIBUTION: the refusal NAMES the substituted directory, which is what shows the EDGE binding produced it rather than an accidental catch. reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.substituted, `the verdict is attributed to the directory being SUBSTITUTED — reason: ${reasonOf(result)}`);
    assert.match(readFileSync(coderPath(dir), 'utf8'), /TAMPERED/, 'sanity: the substitution actually landed on the LIVE path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R51 — AC-R48's GUARD, EXTENDED TO THE THREE SHAPES IT DOES NOT COVER.
//
// AC-R48 pins that an unrecognised `_test*` property refuses BY NAME, and it
// exists because a silent drop once cost this suite seven hollow tests. But it
// only ever passes ORDINARY ENUMERABLE OWN properties, so it is satisfied by an
// implementation that scans `Object.keys(options)` — and three real shapes slip
// straight past that scan:
//   ARM 1  INHERITED: a misspelled seam arriving on the PROTOTYPE. Caught by a
//          `for...in` scan, MISSED by `Object.keys` and by `Reflect.ownKeys`.
//   ARM 2  NON-ENUMERABLE OWN: a misspelled seam defined with
//          `enumerable:false`. Caught by `Reflect.ownKeys` /
//          `Object.getOwnPropertyNames`, MISSED by `Object.keys` and by
//          `for...in`.
//   ARM 3  RECOGNISED NAME, WRONG TYPE: a hook seam supplied as a non-function.
//          Spelled correctly, so no name scan of any kind sees it; if it is
//          then silently ignored rather than called, the pin using it injects
//          NOTHING and goes hollow exactly as a dropped name would.
// ARMS 1 AND 2 ARE NOT REDUNDANT — no single scan catches both, so each one
// discriminates a different wrong implementation. That is the whole reason they
// are separate arms rather than one.
//
// ARM 3 DELIBERATELY EXCLUDES `_testForcePlatform`: it is legitimately a STRING
// ('win32'), so requiring "recognised seams must be functions" of it would
// contradict AC-R35/AC-R36. The rule pinned here is narrower and correct: a
// recognised HOOK seam must be a function.
//
// CONTROL ARM PLACED FIRST: the same fixture with correctly-spelled,
// correctly-typed seams must CLEAR. Without it, every refusal below is equally
// explained by "this fixture refuses", and a guard about telling shapes apart
// cannot be pinned by a module that refuses everything.
//
// TOLERANT ON CALLING CONVENTION, STRICT ON EFFECT — same treatment as AC-R48
// and AC-R17: "refuses loudly" is satisfied by EITHER a resolved
// `{cleared:false, reason}` naming the property OR a rejection whose message
// names it. The invariants are the DURABLE EFFECT (the latch survives) and
// ATTRIBUTION (the offending name appears).
//
// EXPECTED FAILURE SHAPE — RED TODAY, ON PURPOSE, IF THE HARDENING HAS NOT
// LANDED. This pin is authored against seam-validation hardening that was in
// flight when it was written (unknown-key detection extending to inherited and
// non-enumerable keys; a recognised seam supplied as a non-function refusing by
// name). Until that lands, ARM 1 and ARM 2 fail as `cleared === true` with the
// latch gone (the property was ignored), and ARM 3 fails as `cleared === true`
// (the non-function was ignored and the call proceeded normally). Those are the
// defect being pinned, not a defect in the pin — do not soften them to reach
// green.
//
// NAMED SABOTAGE (one line, per arm): narrow the unknown-key scan back to
// `Object.keys(options)` -> ARMS 1 AND 2 go red while AC-R48 stays green.
// Delete the `typeof seam === 'function'` validation on the recognised hook
// seams -> ARM 3 goes red while AC-R48 and every other pin stay green.
// ===========================================================================
test('AC-R51: an unrecognised seam arriving INHERITED or NON-ENUMERABLE, and a recognised hook seam supplied as a NON-FUNCTION, each REFUSE BY NAME — a scan of enumerable own keys is not enough', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ---- CONTROL ARM, PLACED FIRST, MUST PASS FOR THE OPPOSITE REASON.
  {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));
      const r = await reconcileEnforcementTaint({
        cwd: dir,
        ...CONDUCTOR,
        _testHookBeforeConfirm: () => {},
        _testHookInsideConfirm: () => {},
      });
      assert.equal(r.cleared, true, `CONTROL: correctly-spelled, correctly-typed seams must not refuse — otherwise the refusals below say nothing about SHAPE. reason: ${reasonOf(r)}`);
      assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: the latch is genuinely removed');
    } finally {
      cleanup();
    }
  }

  // Each arm builds its options object DIFFERENTLY (that is the point), so it is
  // described by a builder plus the name that must be attributed.
  const arms = [
    {
      label: 'ARM 1 — INHERITED unrecognised seam (on the prototype, invisible to Object.keys and Reflect.ownKeys)',
      offender: '_testHookBeforeConfrim',
      build: (dir) => {
        const opts = Object.create({ _testHookBeforeConfrim: () => {} });
        opts.cwd = dir;
        opts.callerRole = CONDUCTOR.callerRole;
        return opts;
      },
    },
    {
      label: 'ARM 2 — NON-ENUMERABLE OWN unrecognised seam (invisible to Object.keys and for...in)',
      offender: '_testHookInsideConfrim',
      build: (dir) => {
        const opts = { cwd: dir, ...CONDUCTOR };
        Object.defineProperty(opts, '_testHookInsideConfrim', { value: () => {}, enumerable: false, configurable: true, writable: true });
        return opts;
      },
    },
    {
      label: 'ARM 3a — RECOGNISED hook seam supplied as a NUMBER (correctly spelled, so no name scan can see it)',
      offender: '_testHookBeforeConfirm',
      build: (dir) => ({ cwd: dir, ...CONDUCTOR, _testHookBeforeConfirm: 42 }),
    },
    {
      label: 'ARM 3b — RECOGNISED hook seam supplied as a STRING',
      offender: '_testHookInsideConfirm',
      build: (dir) => ({ cwd: dir, ...CONDUCTOR, _testHookInsideConfirm: 'not a function' }),
    },
  ];

  for (const arm of arms) {
    const { dir, cleanup } = makeGitProject();
    try {
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-clearing fixture

      let result;
      let threw = null;
      try {
        result = await reconcileEnforcementTaint(arm.build(dir));
      } catch (e) {
        threw = e;
      }

      const text = threw ? oneLine(threw.message || String(threw)) : reasonOf(result);
      if (!threw) {
        assert.notEqual(
          result.cleared,
          true,
          `${arm.label}: an abnormally-shaped seam must REFUSE, never be silently ignored. Ignoring it means a pin written with that shape injects NOTHING and passes while measuring nothing — the seven-hollow-tests failure AC-R48 records, reached by a route AC-R48 does not cover. reason: ${text}`
        );
      }
      assert.equal(existsSync(latchPath(dir)), true, `${arm.label}: THE DURABLE EFFECT — the latch survives an abnormal-seam refusal`);
      assert.match(
        text,
        new RegExp(arm.offender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${arm.label}: THE ATTRIBUTION — the refusal must NAME the offending property (${arm.offender}), or an operator cannot find it, and an unattributable {cleared:false} is indistinguishable from a silent ignore. got: ${text}`
      );
    } finally {
      cleanup();
    }
  }
});

// ###########################################################################
// S4 BASELINE-LIST REWORK — AC-R52 .. AC-R58. Authored against decision
// `b-baseline-hash-list-concrete-design` (fe861066), the concrete design that
// deletes the enforcement stamp and replaces it with the persistent
// `.sterling/enforcement-baseline.json` list. AC-R52 is the R9 replacement;
// AC-R53..AC-R55 pin the ADOPT mode fe861066 D2/D5 introduce; AC-R56/AC-R57
// pin the (A)/(B) latch-domain split (D5 LATCH DOMAIN); AC-R58 pins
// `minted_at` as diagnostic-only (D1).
// ###########################################################################

// A git-TRACKED file INSIDE the settled (A) scope: `hooks/**` (union member 1
// of the two — see the header's (A)/(B) LATCH DOMAIN note,
// `scripts/hooks/lib/contract.mjs:31`). Committed during setup so a later
// uncommitted edit is genuine dirt relative to HEAD.
function addTrackedHooksFile(dir) {
  const p = join(dir, 'hooks', 'some-file.mjs');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '// a tracked hook file\n');
  git(dir, ['add', 'hooks/some-file.mjs'], { must: true });
  git(dir, ['commit', '-q', '-m', 'add tracked hooks/** file'], { must: true });
  return p;
}

// A git-TRACKED file OUTSIDE the settled (A) scope: it matches neither
// `hooks/**` nor the shared ENFORCEMENT_SURFACE export (`.claude/agents/**`,
// `.claude/settings*.json`, `.sterling/config.json` — the same glob set as
// BASELINE_GLOBS above), so it can never perturb a (B) baseline fixture
// either. Used by AC-R56's CONTROL arm to prove (A) is scoped to the union,
// not to "any repo dirt".
function addOutOfScopeTrackedFile(dir) {
  const p = join(dir, '.claude', 'CLAUDE.md');
  writeFileSync(p, '# project instructions (committed, tracked)\n');
  git(dir, ['add', '.claude/CLAUDE.md'], { must: true });
  git(dir, ['commit', '-q', '-m', 'add tracked out-of-scope file'], { must: true });
  return p;
}

// ===========================================================================
// AC-R52 — THE BASELINE LIST FILE ITSELF MUTATING BETWEEN VERIFICATION AND
// REMOVAL. REPLACES THE DISSOLVED AC-R9: the ephemeral per-call stamp AC-R9
// pinned is deleted (decision 78dc9bd6); this is its TOCTOU role, inherited by
// the PERSISTENT list that replaces it as the sole comparator input.
// Expressible with the SAME seam AC-R8 uses (`_testHookAfterEnumeration`,
// which fires after the verdict and before the removal walk) — no new harness
// machinery was needed, so nothing here is pinned weaker than what AC-R9 once
// pinned and called by a new name.
//
// SABOTAGE: read the baseline once at the start and never re-check it before
// the irreversible removal — `existsSync(latchPath(dir))` flips from true to
// false.
// SECOND SABOTAGE (aimed at the discriminator): re-read the baseline but
// report the disagreement as an ordinary hash/incomplete mismatch — the
// changed-during-verification assertion fires instead of the durable effect
// alone carrying the pin. See AC-R8's note.
// ===========================================================================
test('AC-R52: the baseline list file mutating between verification and removal aborts the clear — latch survives (replaces the dissolved AC-R9)', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir));

    const result = await reconcileEnforcementTaint({
      cwd: dir,
      ...CONDUCTOR,
      _testHookAfterEnumeration: async () => {
        // Corrupt the list AFTER the (correct) verdict was computed against
        // it. A valid-looking 64-hex hash so this reads as CHANGED, not
        // MALFORMED — the discriminator this pin is actually about.
        writeFileSync(baselinePath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries: [{ path: CODER_REL, sha256: 'deadbeef'.repeat(8) }] }));
      },
    });
    assert.equal(result.cleared, false, `a baseline-list mutation during verification must abort the clear — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.changed, `THE DISCRIMINATOR: the verdict must be attributed to the LIST CHANGING DURING VERIFICATION — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.ordinaryMismatch, 'a plain manifest-mismatch reason cannot distinguish this from an ordinary bad baseline (AC-R4/AC-R5)');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives a mid-flight baseline-list mutation');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R53 — ADOPT WITH NO LATCH: MINTS THE BASELINE, REPORTS INITIALIZATION,
// CREATES NO LATCH, REMOVES NOTHING. fe861066 D2 BOOTSTRAP (Codex correction):
// "no-latch --adopt = mint baseline, report 'baseline initialized; no latch
// removed'" — this test asserts that EXACT PHRASE, not merely its family,
// because a bootstrap message this specific is either right or it is a
// different message.
//
// SABOTAGE: make ADOPT a no-op when no latch is present (the OLD clearer's
// ordering, which examined the latch before evidence — exactly the ordering
// fe861066 D2 overturns) — no baseline file appears on disk and the
// substring/shape assertions fail.
// SECOND SABOTAGE: report `cleared:true` for a no-latch adopt — nothing was
// CLEARED (no latch existed), so `cleared` must stay false even though a
// baseline was minted.
// ===========================================================================
test('AC-R53: ADOPT with no latch mints a valid sorted baseline matching the current (B) surface, reports initialization, creates no latch, removes nothing', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists');
    assert.equal(existsSync(baselinePath(dir)), false, 'PRECONDITION: no baseline exists');

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, adopt: true });

    assert.equal(result.cleared, false, `THE RETURN CONTRACT: nothing existed to clear, so cleared must stay false even though a baseline was minted — reason: ${reasonOf(result)}`);
    assert.match(reasonOf(result), REASON.adoptInitialized, `THE RULING (fe861066 D2), asserted by family — reason: ${reasonOf(result)}`);
    assert.match(oneLine(result.reason), /baseline initialized; no latch removed/i, `THE RULING (fe861066 D2), asserted VERBATIM — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'ADOPT with no latch creates no latch');

    assert.equal(existsSync(baselinePath(dir)), true, 'a baseline list is minted on disk');
    const written = JSON.parse(readFileSync(baselinePath(dir), 'utf8'));
    assert.equal(written.version, 1, 'the minted baseline carries version 1');
    assert.equal(typeof written.minted_at, 'string', 'the minted baseline carries a minted_at string');
    const expected = sortEntries(exactBaselineFor(dir));
    assert.deepEqual(written.entries, expected, 'the minted baseline entries exactly match the current (B) surface, already sorted');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R54 — ADOPT WITH A LATCH: MINTS + INSTALLS THE LIST, RE-VERIFIES IT, AND
// REMOVES THE LATCH. fe861066 D5: "latch + --adopt = mint, bind/reconfirm,
// then remove latch." A pre-existing (STALE) baseline on disk is IGNORED and
// REPLACED — ADOPT installs what the current surface actually is, which is
// the whole point of the human-acceptance operation.
//
// SABOTAGE: skip minting when a latch is present (treat ADOPT-with-latch as
// plain VERIFY against whatever baseline already exists) — the stale
// pre-existing baseline survives unchanged and either the entries-match
// assertion fails or the call refuses instead of clearing.
// ===========================================================================
test('AC-R54: ADOPT with a latch mints/installs a baseline matching current, and the latch is gone afterwards', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    // A STALE pre-existing baseline, deliberately wrong — ADOPT must overwrite
    // it with the CURRENT surface.
    writeBaseline(dir, [{ path: CODER_REL, sha256: 'deadbeef'.repeat(8) }]);

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, adopt: true });

    assert.equal(result.cleared, true, `ADOPT with a latch, once evidence reconfirms, must remove it — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'the latch is gone afterwards');

    const written = JSON.parse(readFileSync(baselinePath(dir), 'utf8'));
    assert.equal(written.version, 1, 'the installed baseline carries version 1');
    const expected = sortEntries(exactBaselineFor(dir));
    assert.deepEqual(written.entries, expected, 'the installed baseline matches the CURRENT (B) surface — the stale pre-existing one was replaced, not merely left alone');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R55 — ADOPT WITH A LATCH, AN INJECTED FAILURE RE-CONFIRMING EVIDENCE
// BEFORE UNLINK: THE LATCH REMAINS. fe861066 D5's LIST-BEFORE-LATCH ORDERING:
// mint+install happens BEFORE the pre-unlink reconfirmation, so a failure at
// that reconfirmation must leave "a fresh list + a present latch" — the LEGAL
// CRASH STATE — rather than tearing anything down. A subsequent plain VERIFY
// call then clears normally, because the list is already correct.
//
// THE INJECTED FAILURE, deliberately NOT a (B)-surface tamper: SEAM 2
// (`_testHookBeforeRemoval`) is documented to propagate a thrown error (see
// the header's SEAM 2 contract), so this test throws from it to model an
// arbitrary internal failure during the pre-unlink reconfirmation WITHOUT
// touching any file — the list, once minted, stays exactly correct, so the
// SUBSEQUENT VERIFY's success is unambiguous rather than accidental.
//
// SABOTAGE: unlink the latch unconditionally regardless of the reconfirmation
// outcome (treat ADOPT's final step as unconditional cleanup rather than
// gated on success) — the latch disappears despite the injected failure.
// ===========================================================================
test('AC-R55: ADOPT with a latch, an injected failure before unlink, leaves the latch PRESENT — a fresh list plus a present latch is the legal crash state, and a subsequent VERIFY clears it', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, [{ path: CODER_REL, sha256: 'deadbeef'.repeat(8) }]); // stale; ADOPT must overwrite it regardless of the later failure

    let hookCalls = 0;
    let result;
    let threw = null;
    try {
      result = await reconcileEnforcementTaint({
        cwd: dir,
        ...CONDUCTOR,
        adopt: true,
        _testHookBeforeRemoval: () => {
          hookCalls += 1;
          throw new Error('AC-R55 injected failure — models an arbitrary internal failure re-confirming evidence before unlink, without touching any file');
        },
      });
    } catch (e) {
      threw = e;
    }

    assert.equal(hookCalls, 1, 'SEAM 2 CONTRACT: _testHookBeforeRemoval must fire on the ADOPT-with-latch path too, in the same window as VERIFY — immediately before the first syscall of the latch-removal walk');
    if (!threw) {
      assert.notEqual(result.cleared, true, `an injected pre-unlink failure must never be reported as a successful clear — reason: ${reasonOf(result)}`);
    }
    assert.equal(existsSync(latchPath(dir)), true, 'THE RULING: the latch REMAINS — list-before-latch ordering means a fresh list plus a present latch is the legal crash state');

    const written = JSON.parse(readFileSync(baselinePath(dir), 'utf8'));
    const expected = sortEntries(exactBaselineFor(dir));
    assert.deepEqual(written.entries, expected, 'THE ORDERING PROOF: the list was ALREADY minted/installed correctly before the injected failure fired — list-before-latch, not the other way round');

    // A SUBSEQUENT plain VERIFY call, no seams: the list ADOPT left behind is
    // already correct, so it clears normally.
    const second = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(second.cleared, true, `a subsequent VERIFY must clear normally, because the list ADOPT left behind is already exactly correct — reason: ${reasonOf(second)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'the subsequent VERIFY genuinely removes the latch');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R56 — VERIFY REFUSES WHEN THE (A) TRACKED ENFORCEMENT SURFACE IS DIRTY,
// EVEN WITH AN EXACT (B) LIST MATCH — AND ONLY WHEN THE DIRT IS INSIDE THE
// SETTLED (A) SCOPE. fe861066 D5 LATCH DOMAIN: the one latch spans BOTH
// incident classes, so a (B)-only verify must not discharge an (A) incident.
// (A)'S SCOPE IS SETTLED (see the header note): git-reported dirt on
// `hooks/**` UNION the shared ENFORCEMENT_SURFACE export
// (`scripts/hooks/lib/contract.mjs:31`).
//
// THREE ARMS, in order:
//   CONTROL A, PLACED FIRST — the `hooks/**` fixture LEFT CLEAN (matching
//     HEAD) clears normally. Without it, a refusal below could equally mean
//     "this module cannot reconcile a project with a tracked hooks/ file at
//     all", and a green PIN would carry no evidence about DIRTINESS
//     specifically.
//   CONTROL B — a tracked file OUTSIDE both `hooks/**` and ENFORCEMENT_SURFACE
//     (`.claude/CLAUDE.md`, matching neither glob) is DIRTY while (B) matches
//     exactly, and VERIFY STILL CLEARS. This is the scope pin itself: a
//     clearer that refuses on ANY dirty tracked file, not just the settled
//     (A) union, would be unusable mid-branch (a developer with an unrelated
//     uncommitted edit anywhere in the repo could never reconcile) — that
//     false-refusal is exactly what this arm catches.
//   THE PIN — a tracked `hooks/**` file IS dirty, (B) still matches exactly,
//     and VERIFY refuses, attributed to the (A) family.
//
// SABOTAGE (CONTROL B / scope): treat ANY git-dirty tracked file anywhere in
// the repo as an (A) incident, rather than scoping to `hooks/**` UNION
// ENFORCEMENT_SURFACE — CONTROL B flips from `cleared:true` to `cleared:false`
// while THE PIN stays green, so the two diverge exactly where a mis-scoped
// check would.
// SABOTAGE (THE PIN): check only the (B) list match and never consult git
// status for the (A) surface at all — THE PIN's `result.cleared` flips true
// despite the dirty tracked hooks file.
// ===========================================================================
test('AC-R56: VERIFY refuses when the (A) tracked enforcement surface (hooks/** union ENFORCEMENT_SURFACE) is dirty, even with an exact (B) list match — and only for dirt inside that scope', { skip: BEHAVIOURAL_SKIP }, async () => {
  // ---- CONTROL A, PLACED FIRST: the hooks/** fixture LEFT CLEAN.
  {
    const { dir, cleanup } = makeGitProject();
    try {
      addTrackedHooksFile(dir);
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir));

      const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
      assert.equal(result.cleared, true, `CONTROL A: with the tracked hooks/** file CLEAN (matching HEAD) and an exact (B) match, VERIFY must clear — otherwise the refusal below proves nothing about dirtiness specifically. reason: ${reasonOf(result)}`);
      assert.equal(existsSync(latchPath(dir)), false, 'CONTROL A: the latch is genuinely removed');
    } finally {
      cleanup();
    }
  }

  // ---- CONTROL B: a tracked file OUTSIDE both `hooks/**` and
  // ENFORCEMENT_SURFACE is DIRTY, (B) is exact, and VERIFY STILL CLEARS — (A)
  // is scoped to the settled union, not to "any repo dirt".
  {
    const { dir, cleanup } = makeGitProject();
    try {
      const outOfScope = addOutOfScopeTrackedFile(dir);
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir)); // (B) is EXACT here

      writeFileSync(outOfScope, '# dirtied relative to HEAD, never committed — OUTSIDE the (A) scope\n');

      const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
      assert.equal(
        result.cleared,
        true,
        `CONTROL B, THE SCOPE PIN: a tracked file OUTSIDE hooks/** and ENFORCEMENT_SURFACE may be dirty and VERIFY must still CLEAR — a clearer that refuses on ANY dirty tracked file would be unusable mid-branch. reason: ${reasonOf(result)}`
      );
      assert.equal(existsSync(latchPath(dir)), false, 'CONTROL B: the latch is genuinely removed despite the out-of-scope dirt');
    } finally {
      cleanup();
    }
  }

  // ---- THE PIN: a tracked `hooks/**` file IS dirtied relative to HEAD.
  const { dir, cleanup } = makeGitProject();
  try {
    const tracked = addTrackedHooksFile(dir);
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir)); // (B) is EXACT here

    writeFileSync(tracked, '// TAMPERED — modified relative to HEAD, never committed\n');

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.notEqual(
      result.cleared,
      true,
      `THE RULING (fe861066 D5 LATCH DOMAIN): a dirty hooks/** file must refuse EVEN WITH an exact (B) match — reason: ${reasonOf(result)}`
    );
    assert.match(reasonOf(result), REASON.trackedDirty, `the refusal is attributed to the (A) tracked-surface family, not to the (B) baseline (which is exact here) — reason: ${reasonOf(result)}`);
    assert.doesNotMatch(reasonOf(result), REASON.incomplete, 'the (B) baseline is EXACT here; an incomplete-baseline reason would mean the (A) check never fired');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch survives an (A)-dirty refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R57 — ADOPT PROCEEDS DESPITE (A) DIRT, BUT REPORTS IT LOUDLY. fe861066
// D5: ADOPT is the explicitly-named human-acceptance operation, so it does
// NOT refuse on (A) dirt the way default VERIFY does (AC-R56) — but the dirt
// must not be silently swallowed either. Uses the SAME `hooks/**` fixture as
// AC-R56's pin (the settled (A) scope), not an out-of-scope file — this test
// is about ADOPT's behaviour ON GENUINE (A) DIRT, not about scope.
//
// SABOTAGE: refuse on (A) dirt under ADOPT too (collapsing ADOPT's behaviour
// into VERIFY's) — `result.cleared` flips false and the latch survives
// instead of being removed.
// SECOND SABOTAGE: proceed silently, with no mention of the (A) dirt in
// `reason` — the family assertion fails even though `cleared` is correct.
// ===========================================================================
test('AC-R57: ADOPT proceeds despite a dirty hooks/** (A) file, but reports it LOUDLY', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const tracked = addTrackedHooksFile(dir);
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir));
    writeFileSync(tracked, '// TAMPERED — modified relative to HEAD, never committed\n');

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, adopt: true });

    assert.equal(result.cleared, true, `THE RULING (fe861066 D5): ADOPT is the explicit human-acceptance operation and PROCEEDS despite (A) dirt — reason: ${reasonOf(result)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'ADOPT proceeds and removes the latch despite the (A) dirt');
    assert.match(
      reasonOf(result),
      REASON.trackedDirty,
      `THE OTHER HALF OF THE RULING: the (A) dirt is not silently swallowed — it must be named LOUDLY in the very reason that reports success — reason: ${reasonOf(result)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R58 — `minted_at` IS DIAGNOSTIC ONLY, NEVER FRESHNESS OR AUTHORITY.
// fe861066 D1, verbatim: "minted_at (DIAGNOSTIC ONLY — never freshness or
// authority)". A baseline minted long ago must still verify if its ENTRIES
// exactly match current disk — the timestamp carries no veto.
//
// SABOTAGE: refuse (or otherwise treat as stale) a baseline whose minted_at
// is older than some threshold — `result.cleared` flips false despite an
// otherwise-exact match.
// ===========================================================================
test('AC-R58: a baseline with an ANCIENT minted_at but an exact (B) match still verifies — minted_at carries no authority', { skip: BEHAVIOURAL_SKIP }, async () => {
  const { dir, cleanup } = makeGitProject();
  try {
    plantLatch(dir);
    writeBaseline(dir, exactBaselineFor(dir), '1970-01-01T00:00:00.000Z'); // ancient, otherwise exact

    const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });
    assert.equal(
      result.cleared,
      true,
      `THE RULING (fe861066 D1): minted_at is diagnostic only — an ancient timestamp with an otherwise-exact match must still verify — reason: ${reasonOf(result)}`
    );
    assert.equal(existsSync(latchPath(dir)), false, 'the latch is genuinely removed despite the ancient minted_at');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-R59 — SECURITY REVIEW FINDING (MEDIUM): THE (A) TRACKED-DIRT CHECK MUST
// NOT EXECUTE REPO-LOCAL `core.fsmonitor`. AC-R56/AC-R57 pin that VERIFY (and
// ADOPT) consult git for the (A) surface; this pin is about HOW they may do
// it. A bare `git status`/`git diff` in the target repo EXECUTES a
// repo-local `core.fsmonitor` config value as a shell command (git's fsmonitor
// hook-v1 protocol) — so a WRITE-ONLY actor (can write files inside the repo,
// cannot invoke the clearer itself) plants one line in `.git/config` and gets
// arbitrary command execution under the CONDUCTOR'S UID the moment
// reconciliation runs its (A) check. This is exactly the write-capability/
// invocation-capability distinction 0ac7be95 R2 names, reached through a new
// door.
//
// THE FIXTURE plants the config line the way a write-only attacker actually
// would (a repo-local config entry — using `git config` here only because it
// writes `.git/config` correctly quoted; no git INVOCATION by the attacker is
// required for the real exploit, only file write access). The command is a
// `sh -c '...'` wrapper that IGNORES its own argv, because git's fsmonitor
// hook-v1 protocol appends extra arguments (version, time) to whatever
// `core.fsmonitor` names — a fixture that read `$1`/`$2` could accidentally
// look inert on some git versions and not others.
//
// TWO ARMS, per the brief: a normal VERIFY (AC-R1's proven-clearing fixture)
// and one ADOPT arm (AC-R53's proven-no-latch fixture) — cheap because they
// reuse fixtures this file already trusts. BOTH must leave the sentinel
// file ABSENT, and BOTH must reach their ORDINARY verdict unchanged — the
// hardening is a neutralization of the exec vector, not a change to what (A)
// or (B) mean.
//
// EXPECTED RED against the current working tree: the clearer's git
// invocation is not yet hardened, so `git status`/`git diff` picks up the
// repo-local `core.fsmonitor` and the sentinel is created. Authored from THIS
// BEHAVIORAL SPEC (write-only actor plants config, sentinel must never
// appear), not from the parallel hardening diff.
//
// SABOTAGE (one line): remove the `-c core.fsmonitor=` override (or any
// equivalent neutralization) from the git invocation the (A) check uses —
// both arms' sentinel-absence assertions flip to the file EXISTING, while the
// verdict assertions stay green (proving the hardening is orthogonal to
// correctness, not a disguised behavior change).
// ===========================================================================
test('AC-R59: the (A) tracked-dirt check must never execute a repo-local core.fsmonitor command (VERIFY and ADOPT)', { skip: BEHAVIOURAL_SKIP }, async () => {
  // A `sh -c` wrapper that ignores argv: git's fsmonitor hook-v1 protocol
  // appends extra arguments (version, time) to the configured command, so a
  // fixture that referenced $1/$2 could look inert by accident rather than by
  // the hardening actually working.
  function plantFsmonitorExec(dir, sentinelPath) {
    // Written the way a WRITE-ONLY actor would — a repo-local config value —
    // using `git config` only for correct quoting into `.git/config`; no git
    // invocation by the attacker is required for the real exploit.
    git(dir, ['config', 'core.fsmonitor', `sh -c 'touch "${sentinelPath}"'`], { must: true });
  }

  // ---- ARM 1: a normal VERIFY, AC-R1's proven-clearing fixture.
  {
    const { dir, cleanup } = makeGitProject();
    const sentinel = join(tmpdir(), `sterling-ac-r59-verify-${randomUUID()}`);
    try {
      plantFsmonitorExec(dir, sentinel);
      plantLatch(dir);
      writeBaseline(dir, exactBaselineFor(dir)); // AC-R1's proven-clearing fixture, untouched

      const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR });

      assert.equal(
        existsSync(sentinel),
        false,
        'THE RULING: a repo-local core.fsmonitor command must NEVER execute during VERIFY\'s (A) check — its mere presence in .git/config is a write-only actor\'s only foothold, and the sentinel appearing means that foothold became command execution under the conductor\'s UID'
      );
      assert.equal(result.cleared, true, `THE VERDICT MUST BE UNCHANGED: this is AC-R1's exact proven-clearing fixture — the hardening must neutralize the exec vector without altering what a clean (A)/(B) surface verifies as. reason: ${reasonOf(result)}`);
      assert.equal(existsSync(latchPath(dir)), false, 'the latch is genuinely removed, same as AC-R1');
    } finally {
      cleanup();
    }
  }

  // ---- ARM 2: ADOPT with no latch, AC-R53's proven-no-latch fixture (cheap
  // to reuse; still exercises ADOPT's OWN (A) consultation independently).
  {
    const { dir, cleanup } = makeGitProject();
    const sentinel = join(tmpdir(), `sterling-ac-r59-adopt-${randomUUID()}`);
    try {
      plantFsmonitorExec(dir, sentinel);
      assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists (AC-R53\'s fixture)');

      const result = await reconcileEnforcementTaint({ cwd: dir, ...CONDUCTOR, adopt: true });

      assert.equal(
        existsSync(sentinel),
        false,
        'THE RULING, ADOPT ARM: a repo-local core.fsmonitor command must NEVER execute during ADOPT\'s (A) check either — the exec vector is not VERIFY-only'
      );
      assert.equal(result.cleared, false, `THE VERDICT MUST BE UNCHANGED: this is AC-R53's exact no-latch fixture — nothing existed to clear. reason: ${reasonOf(result)}`);
      assert.match(reasonOf(result), REASON.adoptInitialized, 'ADOPT with no latch still mints and reports initialization, unaffected by the hardening');
    } finally {
      cleanup();
    }
  }
});

